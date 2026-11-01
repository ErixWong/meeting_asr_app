/**
 * schema 初始化/迁移验证（sqlite 全量 + 三库方言矩阵）
 *
 * 三种运行模式：
 *   node scripts/db-schema-test.mjs              # sqlite 全量（默认；两种驱动都跑）
 *   node scripts/db-schema-test.mjs --dialect    # 单方言「基线→迁移→记账」套件（DB_TYPE 决定目标）
 *   node scripts/db-schema-test.mjs --matrix     # 三库矩阵：sqlite(两驱动) + mariadb + mssql 各跑一遍
 *
 * 参数（未知参数一律报错退出，不静默忽略）：
 *   --matrix / --dialect / --allow-skip
 *   --allow-skip：存在 SKIP 项时仍以退出码 0 结束。**默认严格**——存在 SKIP ⇒ 退出码非 0
 *   （矩阵模式下 6 项里只跑通 sqlite、外部靶子不可达时，CI 不许绿着过关）。
 *
 * 默认模式覆盖**同一条**实现路径的两个层次（issue #54 之后只剩一条）：
 *   - 引擎层：server/db/schema.mjs 的 initializeSchema()（better-sqlite3 驱动）
 *   - 生产入口层：server/db-shared.mjs 的 getDb() → AsyncDb → initializeSchema()
 *     —— 这就是运行时真正跑的那条（Next 服务端与 app-server 都走它）。
 *     legacy 的 server/database-schema.mjs（node:sqlite 手写 DDL）已在 #54 退役，
 *     本脚本不再引用它：**测的那条必须就是跑的那条**。
 *
 * 场景：
 *   0. **结构性守卫（R2）**：运行时源码里不许出现 node:sqlite / DatabaseSync，
 *      `CREATE TABLE` 只许出现在 server/db/*.mjs（唯一 schema 实现）——见
 *      assertSingleSchemaImplementation()。本项目三次栽在「两份 schema 实现、
 *      测的和跑的不是同一份」上，这条守卫让第二份 schema 一出现就红。
 *   1. 全新库初始化（knex）→ 16 张表 + schema_version = SCHEMA_VERSION（单行）
 *   2. 幂等（knex）：连续两次初始化 → 单行、第二次无 Migration applied、表结构不变
 *   3. 旧库迁移（knex）：构造 v0 旧结构 → 数据搬迁 + legacy 清理 + 录音表
 *   4. 被污染库（knex）：schema_version = [2,3,3] / [2,2] → 收敛成单行 = SCHEMA_VERSION
 *   5. 并发两次初始化（knex）：Promise.all → 单行、无重复迁移、不崩
 *   6. 生产入口（legacy getDb()）：连续两次 → 单行、第二次无 Migration applied
 *   7. 被污染库（legacy）：[2,3,3] / [2,2] → 收敛成单行 = SCHEMA_VERSION（v3 重复执行不报错）
 *   8. 并发两次初始化（legacy）：两个连接 Promise.all → 单行
 *
 * --dialect / --matrix 的库生命周期与安全边界：
 *   mysql / mssql 只允许建/删名字以 `meeting_asr_ci_` 开头的一次性库（共享实例红线），
 *   跑完 DROP；目标库不可达时打印 SKIP 原因并以退出码 3 结束（不许静默假绿）。
 *   子进程（--dialect / 语义锁）始终按严格语义返回 3，矩阵父进程**不会**把 --allow-skip 透传下去。
 */
import { createKnexInstance, getDbType } from "../server/db/index.mjs";
import { AsyncDb, extractRows, listTableColumns } from "../server/db/async-db.mjs";
import {
  INDEXES,
  initializeSchema,
  SCHEMA_VERSION as KNEX_SCHEMA_VERSION,
} from "../server/db/schema.mjs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative, sep } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

/** 抓取一段逻辑里的 console.log 输出（断言用的日志判据都基于它） */
async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function appliedLogs(lines) {
  return lines.filter((line) => line.includes("Migration applied"));
}

async function knexVersionRows(db) {
  const rows = await db.knex.raw("SELECT version FROM schema_version");
  return rows.map((row) => Number(row.version));
}

async function knexStructure(db) {
  const rows = await db.knex.raw(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  );
  return JSON.stringify(rows.map((row) => [row.type, row.name, row.sql]));
}

/** 断言单行 + 值 = SCHEMA_VERSION */
function assertSingleVersionRow(rows, label) {
  assert(
    rows.length === 1,
    `${label}: schema_version 应恰好 1 行，实际 ${rows.length} 行 ${JSON.stringify(rows)}`
  );
  assert(
    rows[0] === KNEX_SCHEMA_VERSION,
    `${label}: schema_version 应为 ${KNEX_SCHEMA_VERSION}，实际 ${rows[0]}`
  );
}

/** 造「被本缺陷污染过的库」：把记账改写成给定的多行值 */
async function polluteKnexVersion(db, versions) {
  await db.prepare("DELETE FROM schema_version").run();
  for (const version of versions) {
    await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  }
}

// ==================== 事务并发回归（issue #54，§4.6.1 / §4.6.2） ====================
//
// AsyncDb 的事务状态原本是**实例级可变状态**（`this.knex = trx` / `_txDepth`）。同步
// 驱动时代所有事务天然串行，缺陷看不出来；异步化后同一实例上的并发事务会互踩：
// 后进入者把 `this.knex` 改写成自己的 trx，先退出者又指回自己的 outerKnex ⇒ 语句
// 可能落在事务之外却仍返回「成功」，或 savepoint 名撞车报 `no such savepoint: sp_1`。
//
// issue #55 起事务句柄显式传递（`withTransaction(async (tx) => …)`），嵌套用 `tx`：
// 语句只能落在事务连接上，普通 db 在事务上下文里调用 prepare/exec 会直接抛错（D2 防线）。
//
// 本套件真跑（不是源码级断言）四条：
//   A 两个并发顶层事务：都提交、互不丢失、不报 savepoint 错
//   B 并发下的嵌套事务：内层抛错只回滚内层，外层与另一个事务照常提交
//   C（sqlite）事务回滚不吞掉并发的非事务写入（单连接语义保持）
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTransactionConcurrencySuite(db, dbType) {
  const check = (name, condition, detail) => {
    if (!condition) throw new Error(`${name} 失败: ${detail}`);
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const describeError = (error) =>
    error instanceof Error ? error.message : String(error);

  await db.knex.schema.dropTableIfExists("tx_probe");
  await db.knex.schema.createTable("tx_probe", (t) => {
    t.string("id", 64).primary();
    t.string("tag", 32).notNullable();
  });

  const ids = async () =>
    (await db.prepare("SELECT id FROM tx_probe ORDER BY id").all()).map((row) => String(row.id));

  try {
    // --- A. 两个并发顶层事务 ---
    await db.prepare("DELETE FROM tx_probe").run();
    let concurrentError = null;
    try {
      await Promise.all([
        db.withTransaction(async (tx) => {
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("a1", "A");
          await sleep(20);
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("a2", "A");
        }),
        db.withTransaction(async (tx) => {
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("b1", "B");
          await sleep(20);
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("b2", "B");
        }),
      ]);
    } catch (error) {
      concurrentError = error;
    }
    const afterConcurrent = await ids();
    check(
      "并发两个顶层事务：都提交且互不丢失（无 savepoint 冲突）",
      concurrentError === null &&
        JSON.stringify(afterConcurrent) === JSON.stringify(["a1", "a2", "b1", "b2"]),
      concurrentError
        ? `抛错 ${describeError(concurrentError)}`
        : `行 ${JSON.stringify(afterConcurrent)}`
    );

    // --- B. 并发下的嵌套：内层抛错只回滚内层 ---
    await db.prepare("DELETE FROM tx_probe").run();
    let nestedError = null;
    try {
      await Promise.all([
        db.withTransaction(async (tx) => {
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("c-outer", "C");
          try {
            await tx.withTransaction(async (tx2) => {
              await tx2.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("c-inner", "C");
              throw new Error("inner-rollback");
            });
          } catch {
            // 内层异常被外层吞掉 → 外层应提交，内层那行必须已回滚
          }
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("c-after", "C");
        }),
        db.withTransaction(async (tx) => {
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("d-1", "D");
        }),
      ]);
    } catch (error) {
      nestedError = error;
    }
    const afterNested = await ids();
    check(
      "并发下嵌套事务：内层抛错只回滚内层、外层与另一事务照常提交",
      nestedError === null &&
        JSON.stringify(afterNested) === JSON.stringify(["c-after", "c-outer", "d-1"]),
      nestedError
        ? `抛错 ${describeError(nestedError)}`
        : `行 ${JSON.stringify(afterNested)}（c-inner 应被回滚）`
    );

    // --- C. 事务回滚不吞掉并发的非事务写入（sqlite 单连接语义保持）---
    if (dbType === "sqlite") {
      await db.prepare("DELETE FROM tx_probe").run();
      const rollbackTx = db
        .withTransaction(async (tx) => {
          await tx.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("tx-doomed", "T");
          await sleep(30);
          throw new Error("rollback-whole");
        })
        .catch(() => "rolled-back");
      const outsideWrite = (async () => {
        await sleep(5);
        await db.prepare("INSERT INTO tx_probe (id, tag) VALUES (?, ?)").run("outside-1", "X");
      })();
      const [, txOutcome] = await Promise.all([outsideWrite, rollbackTx]);
      const afterRollback = await ids();
      check(
        "事务回滚不吞掉并发的非事务写入（sqlite 单连接）",
        txOutcome === "rolled-back" &&
          JSON.stringify(afterRollback) === JSON.stringify(["outside-1"]),
        `行 ${JSON.stringify(afterRollback)}（tx-doomed 应回滚，outside-1 应保留）`
      );
    }
  } finally {
    await db.knex.schema.dropTableIfExists("tx_probe");
  }
}

/**
 * 造 v0 旧库结构（真实旧库形态：所有表齐全，仅 meeting_llm_results / meeting_send_records
 * 是「以 meeting_asr_result_id 关联」的旧结构）。场景 3 与场景 3b 共用。
 */
async function createLegacyV0Schema(db) {
  await db.knex.raw(`CREATE TABLE meetings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, source_type TEXT NOT NULL,
    source_file_name TEXT, duration_seconds INTEGER, status TEXT NOT NULL,
    status_updated_at TEXT NOT NULL, last_error_message TEXT,
    created_by_user_id TEXT NOT NULL, created_by_user_name TEXT NOT NULL,
    created_by_user_email TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await db.knex.raw(`CREATE TABLE meeting_asr_results (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, asr_provider TEXT NOT NULL,
    asr_setting_mark TEXT NOT NULL, asr_config_snapshot TEXT NOT NULL,
    capture_session_id TEXT NOT NULL, result_format TEXT NOT NULL,
    raw_payload TEXT NOT NULL, normalized_text TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await db.knex.raw(`CREATE TABLE llm_prompt_templates (id TEXT PRIMARY KEY)`);
  await db.knex.raw(`CREATE TABLE users (id TEXT PRIMARY KEY)`);
  await db.knex.raw(`CREATE TABLE roles (id TEXT PRIMARY KEY, role_key TEXT NOT NULL, role_name TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await db.knex.raw(`CREATE TABLE user_roles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role_id TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await db.knex.raw(`CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
  await db.knex.raw(`CREATE TABLE app_settings (item_section TEXT NOT NULL, item_mark TEXT NOT NULL, item_title TEXT NOT NULL, item_description TEXT NOT NULL, item_value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (item_section, item_mark))`);
  await db.knex.raw(`CREATE TABLE asr_capture_sessions (capture_session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, asr_provider TEXT NOT NULL, asr_config_snapshot TEXT NOT NULL, hotwords_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  await db.knex.raw(`CREATE TABLE audit_logs (id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, actor_account_name TEXT NOT NULL, actor_display_name TEXT NOT NULL, action_type TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, resource_name TEXT, request_id TEXT, result TEXT NOT NULL, error_message TEXT, before_snapshot TEXT, after_snapshot TEXT, created_at TEXT NOT NULL)`);
  await db.knex.raw(`CREATE TABLE asr_hotwords (id TEXT PRIMARY KEY, term TEXT NOT NULL UNIQUE, weight INTEGER NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await db.knex.raw(`CREATE TABLE meeting_llm_results (
    id TEXT PRIMARY KEY, meeting_asr_result_id TEXT NOT NULL,
    llm_setting_mark TEXT, prompt_template_id TEXT, generation_config_snapshot TEXT,
    generation_mode TEXT, status TEXT, version_no INTEGER, result_type TEXT, result_title TEXT,
    raw_prompt TEXT, raw_response TEXT, result_markdown TEXT, error_message TEXT, created_at TEXT
  )`);
  await db.knex.raw(`CREATE TABLE meeting_send_records (
    id TEXT PRIMARY KEY, meeting_llm_result_id TEXT NOT NULL, mail_template_type TEXT,
    subject TEXT, to_recipients_json TEXT, cc_recipients_json TEXT, body_markdown TEXT,
    body_html TEXT, status TEXT, mail_setting_mark TEXT, mail_config_snapshot TEXT,
    provider_type TEXT, provider_message_id TEXT, error_message TEXT, sent_by_user_id TEXT,
    created_at TEXT, sent_at TEXT
  )`);
}

/**
 * 场景 3b 的旧库数据：刻意包含
 *   - 同一会议同一 version_no 的 3 条重复 llm_result（旧 schema 允许，新 schema UNIQUE 会冲突）
 *   - 一条关联不到 asr 的孤儿 llm_result（迁移时 JOIN 丢弃）
 *   - 两条 send_record：一条挂将被去重丢弃的 llm-a1、一条挂保留的 llm-a3
 */
async function buildLegacyV0WithDuplicates(db) {
  await createLegacyV0Schema(db);
  const now = "2026-07-01T00:00:00.000Z";
  const insertMeeting = `INSERT INTO meetings (id, title, source_type, status, status_updated_at,
    created_by_user_id, created_by_user_name, created_at, updated_at)
    VALUES (?, ?, 'upload', 'transcribed', ?, 'u1', '用户一', ?, ?)`;
  await db.knex.raw(insertMeeting, ["meeting-a", "会议A", now, now, now]);
  await db.knex.raw(insertMeeting, ["meeting-b", "会议B", now, now, now]);
  const insertAsr = `INSERT INTO meeting_asr_results (id, meeting_id, asr_provider, asr_setting_mark,
    asr_config_snapshot, capture_session_id, result_format, raw_payload, normalized_text, created_at)
    VALUES (?, ?, 'p', 'm', '{}', ?, 'f', '{}', ?, ?)`;
  await db.knex.raw(insertAsr, ["asr-a", "meeting-a", "cap-1", "文本A", now]);
  await db.knex.raw(insertAsr, ["asr-b", "meeting-b", "cap-2", "文本B", now]);
  const insertLlm = `INSERT INTO meeting_llm_results (id, meeting_asr_result_id, llm_setting_mark,
    prompt_template_id, generation_config_snapshot, generation_mode, status, version_no,
    result_type, result_title, raw_prompt, raw_response, result_markdown, error_message, created_at)
    VALUES (?, ?, 'm', 'tpl-1', '{}', 'manual', 'succeeded', ?, 'summary', ?, '', '', ?, NULL, ?)`;
  // 会议A v1：3 条重复（created_at 依次更晚，最新 id=llm-a3）
  await db.knex.raw(insertLlm, ["llm-a1", "asr-a", 1, "早版本", "内容-1", "2026-07-01T00:00:00.000Z"]);
  await db.knex.raw(insertLlm, ["llm-a2", "asr-a", 1, "中版本", "内容-2", "2026-07-02T00:00:00.000Z"]);
  await db.knex.raw(insertLlm, ["llm-a3", "asr-a", 1, "晚版本", "内容-3", "2026-07-03T00:00:00.000Z"]);
  // 会议A v2：唯一
  await db.knex.raw(insertLlm, ["llm-a4", "asr-a", 2, "V2", "内容-4", "2026-07-04T00:00:00.000Z"]);
  // 会议B v1：唯一
  await db.knex.raw(insertLlm, ["llm-b1", "asr-b", 1, "B版本", "内容-5", "2026-07-05T00:00:00.000Z"]);
  // 孤儿：关联不存在的 asr（迁移应丢弃）
  await db.knex.raw(insertLlm, ["llm-orphan", "asr-no-such", 1, "孤儿", "内容-6", "2026-07-06T00:00:00.000Z"]);
  const insertSend = `INSERT INTO meeting_send_records (id, meeting_llm_result_id, mail_template_type,
    subject, to_recipients_json, cc_recipients_json, body_markdown, body_html, status,
    mail_setting_mark, mail_config_snapshot, provider_type, sent_by_user_id, created_at)
    VALUES (?, ?, 'meeting', ?, '[]', '[]', '正文', '<p>正文</p>', 'success', 'm', '{}', 'smtp', 'u1', ?)`;
  await db.knex.raw(insertSend, ["send-a1", "llm-a1", "主题A1", now]);
  await db.knex.raw(insertSend, ["send-a3", "llm-a3", "主题A3", now]);
}

// ==================== 结构性守卫（R2）：只允许一份 schema 实现 ====================
//
// 背景：本项目已经三次栽在「两份 schema 实现、测的和跑的不是同一份」上
// （#51 版本记账、#53 方言基建只有脚本调、#54 legacy 与 knex 两套 DDL 并存）。
// #54 已删除 legacy 的 `server/database-schema.mjs`（node:sqlite 手写 DDL），
// 这里把它变成**结构性断言**，让下面两种情况在 CI 里立刻红，而不是靠人记：
//   ① 运行时源码（`src/`、`server/`）里出现 `import … from "node:sqlite"` 或
//      `new DatabaseSync` —— 驱动已统一为 knex（better-sqlite3 / mysql2 / tedious）；
//   ② `CREATE TABLE` 出现在 `server/db/*.mjs` 之外 —— schema 只能有一个实现。
// 注意：`tests/` 不在扫描范围内（那是未接 CI 的手工脚本，见 tests/README.md）。
// 注释里提到 `node:sqlite` 不算违规，所以匹配前先剥注释。

const RUNTIME_SOURCE_ROOTS = ["src", "server"];
const SCHEMA_IMPL_DIR = "server/db";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs", ".mts", ".cts"]);

/** 剥掉块注释与行注释（保留 `http://` 这类带冒号的串，避免误伤） */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walkSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 结构性守卫（跑在 `db:test-schema` 链路的最前面）。
 * 任何一条违规都会让 `db:test-schema` / `db:test-parity` 直接红。
 */
function assertSingleSchemaImplementation() {
  const root = process.cwd();
  const violations = [];
  let scanned = 0;

  for (const sourceRoot of RUNTIME_SOURCE_ROOTS) {
    for (const file of walkSourceFiles(join(root, sourceRoot))) {
      const rel = relative(root, file).split(sep).join("/");
      const code = stripComments(readFileSync(file, "utf-8"));
      scanned += 1;

      const importsSqlite =
        /from\s+["']node:sqlite["']/.test(code) ||
        /require\(\s*["']node:sqlite["']\s*\)/.test(code) ||
        /import\(\s*["']node:sqlite["']\s*\)/.test(code);
      const usesDatabaseSync = /\bnew\s+DatabaseSync\b/.test(code);
      if (importsSqlite || usesDatabaseSync) {
        violations.push(
          `${rel}: 运行时源码不许再引入 node:sqlite / new DatabaseSync（驱动已统一为 knex，legacy 已退役）`
        );
      }

      if (/\bCREATE\s+TABLE\b/i.test(code)) {
        const inSchemaImpl = rel.startsWith(`${SCHEMA_IMPL_DIR}/`) && rel.endsWith(".mjs");
        if (!inSchemaImpl) {
          violations.push(
            `${rel}: CREATE TABLE 只允许出现在 ${SCHEMA_IMPL_DIR}/*.mjs（schema 只许有一个实现）`
          );
        }
      }
    }
  }

  assert(
    violations.length === 0,
    `结构性守卫失败（${violations.length} 处违规）:\n  - ${violations.join("\n  - ")}`
  );
  console.log(
    `✅ 场景0 结构性守卫: 扫描 ${scanned} 个运行时源文件 —— 无 node:sqlite/DatabaseSync，CREATE TABLE 仅存在于 ${SCHEMA_IMPL_DIR}/*.mjs`
  );
}

async function main() {
  // --- 场景 0：结构性守卫（R2）---
  assertSingleSchemaImplementation();

  console.log(`[info] SCHEMA_VERSION = ${KNEX_SCHEMA_VERSION}（唯一实现：server/db/schema.mjs）`);

  const dir = mkdtempSync(join(tmpdir(), "db-schema-test-"));
  process.env.SQLITE_PATH = join(dir, "test.db");

  const db = new AsyncDb(createKnexInstance("sqlite"));

  // --- 场景 1：全新库 ---
  await initializeSchema(db);
  const tables = await db.knex.raw(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  const tableNames = tables.map((r) => r.name).sort();
  const expected = [
    "app_settings", "asr_capture_events", "asr_capture_sessions", "asr_hotwords",
    "audit_logs", "auth_sessions", "llm_prompt_templates", "meeting_asr_results",
    "meeting_llm_results", "meeting_send_records", "meetings", "roles",
    "schema_version", "user_roles", "users", "meeting_audio_recordings",
  ].sort();
  assert(JSON.stringify(tableNames) === JSON.stringify(expected), `表清单不符: ${tableNames}`);
  assertSingleVersionRow(await knexVersionRows(db), "场景1");
  console.log(`✅ 场景1 全新库初始化: 16 张表 + schema_version=${KNEX_SCHEMA_VERSION}（单行）`);

  // --- 场景 2：幂等（连续两次，第二次不得有 Migration applied、结构不变）---
  const structureBefore2 = await knexStructure(db);
  const logs2 = await captureLogs(async () => {
    await initializeSchema(db);
  });
  assert(
    appliedLogs(logs2).length === 0,
    `场景2: 第二次初始化不应出现 Migration applied，实际 ${JSON.stringify(appliedLogs(logs2))}`
  );
  assertSingleVersionRow(await knexVersionRows(db), "场景2");
  assert((await knexStructure(db)) === structureBefore2, "场景2: 两次初始化之间表结构发生变化");
  console.log("✅ 场景2 幂等: 第二次初始化无 Migration applied、单行、结构不变");

  // --- 场景 4：被污染库（knex）---
  await polluteKnexVersion(db, [2, 3, 3]);
  assert((await knexVersionRows(db)).length === 3, "场景4: 污染构造失败");
  const logs4 = await captureLogs(async () => {
    await initializeSchema(db);
  });
  assertSingleVersionRow(await knexVersionRows(db), "场景4 [2,3,3]");
  console.log(
    `✅ 场景4a 被污染库 [2,3,3] → 单行 v${KNEX_SCHEMA_VERSION}（日志: ${JSON.stringify(logs4)}）`
  );

  // 污染成 MAX < 3：v3 会被重复执行，必须仍然幂等不报错
  await polluteKnexVersion(db, [2, 2]);
  const logs4b = await captureLogs(async () => {
    await initializeSchema(db);
  });
  assertSingleVersionRow(await knexVersionRows(db), "场景4 [2,2]");
  assert(
    appliedLogs(logs4b).some((line) => line.includes("v3")) &&
      appliedLogs(logs4b).some((line) => line.includes(`v${KNEX_SCHEMA_VERSION}`)),
    `场景4: [2,2] 应重跑 v3 与 v${KNEX_SCHEMA_VERSION}，实际 ${JSON.stringify(appliedLogs(logs4b))}`
  );
  console.log("✅ 场景4b 被污染库 [2,2] → v3 重复执行不报错、收敛单行");

  // --- 场景 5：并发两次初始化（knex，同一进程 Promise.all）---
  await polluteKnexVersion(db, [2, 3, 3]);
  const logs5 = await captureLogs(async () => {
    await Promise.all([initializeSchema(db), initializeSchema(db)]);
  });
  assertSingleVersionRow(await knexVersionRows(db), "场景5 并发");
  assert(
    appliedLogs(logs5).filter((line) => line.includes(`v${KNEX_SCHEMA_VERSION}`)).length <= 1,
    `场景5: 并发初始化不应重复跑 v${KNEX_SCHEMA_VERSION}，实际 ${JSON.stringify(appliedLogs(logs5))}`
  );
  console.log("✅ 场景5 并发两次 initializeSchema: 单行、无重复迁移、无 savepoint 崩溃");

  // --- 场景 5b：事务并发回归（issue #54，串行化语义）---
  await runTransactionConcurrencySuite(db, "sqlite");
  console.log("✅ 场景5b 事务并发回归（sqlite）: 并发事务不互踩、内层回滚不伤外层");

  await db.knex.destroy();

  // --- 场景 3：旧库迁移（knex）---
  const dir2 = mkdtempSync(join(tmpdir(), "db-migrate-test-"));
  process.env.SQLITE_PATH = join(dir2, "old.db");
  const db2 = new AsyncDb(createKnexInstance("sqlite"));
  // 构造 v0 旧结构（模拟真实旧库：所有表齐全，仅 meeting_llm_results 为旧结构）
  await createLegacyV0Schema(db2);
  // 造数据
  await db2.knex.raw("INSERT INTO meetings (id, title, source_type, status, status_updated_at, created_by_user_id, created_by_user_name, created_at, updated_at) VALUES ('m1', '会议1', 'mic', 'completed', '2026-08-01T00:00:00.000Z', 'u1', '用户1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')");
  await db2.knex.raw("INSERT INTO meeting_asr_results (id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot, capture_session_id, result_format, raw_payload, normalized_text, created_at) VALUES ('asr1', 'm1', 'funasr', 's1', '{}', 'cap1', 'json', '{}', '转写文本', '2026-08-01T00:00:00.000Z')");
  await db2.knex.raw("INSERT INTO llm_prompt_templates (id) VALUES ('tpl1')");
  await db2.knex.raw("INSERT INTO users (id) VALUES ('u1')");
  await db2.knex.raw(`INSERT INTO meeting_llm_results (id, meeting_asr_result_id, llm_setting_mark,
    prompt_template_id, generation_config_snapshot, generation_mode, status, version_no,
    result_type, result_title, raw_prompt, raw_response, result_markdown, error_message, created_at)
    VALUES ('llm1', 'asr1', 'llm1', 'tpl1', '{}', 'summary', 'completed', 1, 'summary',
            '标题', '提示词', '响应', '**纪要**', NULL, '2026-08-01T00:00:00.000Z')`);
  await db2.knex.raw(`INSERT INTO meeting_send_records (id, meeting_llm_result_id, mail_template_type,
    subject, to_recipients_json, cc_recipients_json, body_markdown, body_html, status,
    mail_setting_mark, mail_config_snapshot, provider_type, sent_by_user_id, created_at)
    VALUES ('send1', 'llm1', 'summary', '主题', '[]', '[]', '内容', '<p>内容</p>', 'sent',
            'mail1', '{}', 'smtp', 'u1', '2026-08-01T00:00:01.000Z')`);

  await initializeSchema(db2);

  const migrated = await db2.knex.raw("SELECT * FROM meeting_llm_results");
  assert(migrated.length === 1, `迁移后 meeting_llm_results 应有 1 行`);
  assert(migrated[0].meeting_id === "m1", `meeting_id 未回填: ${JSON.stringify(migrated[0])}`);
  assert(migrated[0].input_transcript_snapshot === "转写文本", "input_transcript_snapshot 未填充");
  assert(migrated[0].result_markdown === "**纪要**", "result_markdown 丢失");
  const sendRows = await db2.knex.raw("SELECT * FROM meeting_send_records");
  assert(sendRows.length === 1 && sendRows[0].id === "send1", "send_records 迁移失败");
  const legacyLlm = await db2.knex.raw(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meeting_llm_results_legacy','meeting_send_records_legacy')"
  );
  assert(legacyLlm.length === 0, "legacy 表未清理");
  assertSingleVersionRow(await knexVersionRows(db2), "场景3 旧库迁移");
  // feat-261101-01 反向断言：旧库（v0 结构）迁移后必须有会议录音表
  const audioCols = await listTableColumns(db2, "meeting_audio_recordings");
  for (const column of [
    "id", "capture_session_id", "meeting_id", "file_path", "raw_file_path",
    "format", "status", "bytes", "duration_seconds", "sample_rate",
    "bitrate_kbps", "error_message", "created_at", "updated_at", "expires_at",
  ]) {
    assert(audioCols.includes(column), `meeting_audio_recordings 缺少列 ${column}: ${audioCols}`);
  }
  console.log(
    `✅ 场景3 旧库迁移: 数据搬迁 + legacy 清理 + 单行 v${KNEX_SCHEMA_VERSION} + meeting_audio_recordings 15 列齐全`
  );
  await db2.knex.destroy();

  // --- 场景 3b：旧库去重与孤儿丢弃（自 tests/verify-migration.mjs 折叠而来）---
  // 覆盖「重复版本去重保留最新」「孤儿 llm_result 丢弃」「孤儿 send_record 丢弃」
  // 「meeting_id 无空行」「二次幂等」「全新库直接新结构 + 索引」—— 这几条原先只有
  // 那份手工脚本在测，现折叠进 CI 唯一路径（映射见交付报告）。
  const dir2b = mkdtempSync(join(tmpdir(), "db-dedup-test-"));
  process.env.SQLITE_PATH = join(dir2b, "dedup.db");
  const db3 = new AsyncDb(createKnexInstance("sqlite"), "sqlite");
  await buildLegacyV0WithDuplicates(db3);
  await initializeSchema(db3);

  assertSingleVersionRow(await knexVersionRows(db3), "场景3b 去重迁移");
  const llmColsAfter = await listTableColumns(db3, "meeting_llm_results");
  assert(
    llmColsAfter.includes("meeting_id") && !llmColsAfter.includes("meeting_asr_result_id"),
    `场景3b: meeting_llm_results 应为新结构，实际列 ${llmColsAfter}`
  );
  const dedupRows = await db3
    .prepare("SELECT id, meeting_id, version_no FROM meeting_llm_results ORDER BY id")
    .all();
  assert(
    dedupRows.length === 3,
    `场景3b: 去重+丢孤儿后应有 3 行，实际 ${dedupRows.length} 行 ${JSON.stringify(dedupRows)}`
  );
  const keptA1 = await db3
    .prepare("SELECT id FROM meeting_llm_results WHERE meeting_id = 'meeting-a' AND version_no = 1")
    .all();
  assert(
    keptA1.length === 1 && keptA1[0].id === "llm-a3",
    `场景3b: 会议A v1 应保留最新 llm-a3，实际 ${JSON.stringify(keptA1)}`
  );
  const orphanLlm = await db3.prepare("SELECT COUNT(*) as c FROM meeting_llm_results WHERE id = 'llm-orphan'").get();
  assert(Number(orphanLlm.c) === 0, "场景3b: 孤儿 llm-orphan 应被丢弃");
  const emptyMeetingId = await db3
    .prepare("SELECT COUNT(*) as c FROM meeting_llm_results WHERE meeting_id IS NULL OR meeting_id = ''")
    .get();
  assert(Number(emptyMeetingId.c) === 0, "场景3b: 不应有 meeting_id 空行");
  const sendAfter = await db3.prepare("SELECT meeting_llm_result_id FROM meeting_send_records").all();
  assert(
    sendAfter.length === 1 && sendAfter[0].meeting_llm_result_id === "llm-a3",
    `场景3b: send_records 应只保留 llm-a3 关联（孤儿 send_record 丢弃），实际 ${JSON.stringify(sendAfter)}`
  );
  const legacyLeft = await db3
    .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%legacy%'")
    .all();
  assert(legacyLeft.length === 0, `场景3b: 不应有 legacy 表残留，实际 ${JSON.stringify(legacyLeft)}`);

  // 二次幂等：版本不变、行数不变
  const logs3b = await captureLogs(async () => {
    await initializeSchema(db3);
  });
  assertSingleVersionRow(await knexVersionRows(db3), "场景3b 二次初始化");
  assert(appliedLogs(logs3b).length === 0, `场景3b: 二次初始化不应重复迁移，实际 ${JSON.stringify(appliedLogs(logs3b))}`);
  const rowsAfterSecond = await db3.prepare("SELECT COUNT(*) as c FROM meeting_llm_results").get();
  assert(Number(rowsAfterSecond.c) === 3, "场景3b: 二次初始化后行数应仍为 3");

  // 全新库：直接新结构 + v1 迁移后重建的索引存在
  const dir2c = mkdtempSync(join(tmpdir(), "db-dedup-fresh-"));
  process.env.SQLITE_PATH = join(dir2c, "fresh.db");
  const db4 = new AsyncDb(createKnexInstance("sqlite"), "sqlite");
  await initializeSchema(db4);
  assert(
    (await listTableColumns(db4, "meeting_llm_results")).includes("meeting_id"),
    "场景3b: 全新库 meeting_llm_results 应直接是新结构"
  );
  const freshIndex = await db4
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_meeting_llm_results_meeting_version_created'"
    )
    .all();
  assert(freshIndex.length === 1, "场景3b: 全新库应有 idx_meeting_llm_results_meeting_version_created");
  console.log(
    "✅ 场景3b 旧库去重: 6 条重复 → 3 条（保留最新 llm-a3）+ 孤儿 llm/send 丢弃 + 二次幂等 + 全新库新结构"
  );
  await db3.knex.destroy();
  await db4.knex.destroy();

  // --- 场景 6：生产入口（**新入口** getDb()，server/db-shared.mjs）---
  // #54 之后运行时唯一的入口就是 getDb() → AsyncDb → initializeSchema()。
  // 这里不再直连 node:sqlite（legacy 已退役），测的就是跑的那条。
  const dir3 = mkdtempSync(join(tmpdir(), "db-prod-entry-test-"));
  mkdirSync(join(dir3, "data"), { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(dir3);
  process.env.SQLITE_PATH = join(dir3, "data", "meeting-asr-app.db");
  const { getDb: getProdDb, closeDb } = await import("../server/db-shared.mjs");

  let prodDb = null;
  const logs6a = await captureLogs(async () => {
    prodDb = await getProdDb();
  });
  assert(prodDb !== null, "场景6: 生产入口 getDb() 未返回句柄");
  assert(prodDb.dbType === "sqlite", `场景6: 生产入口 dbType 应为 sqlite，实际 ${prodDb.dbType}`);

  // 生产入口必须真的把 SQLite 专属 PRAGMA 下发到位（#54 修掉「busy_timeout 写在没人调用
  // 的工厂里」这一错位：接线后它才真正生效）。
  const journalRow = await prodDb.prepare("PRAGMA journal_mode").get();
  assert(
    String(journalRow?.journal_mode ?? "").toLowerCase() === "wal",
    `场景6: 生产入口 journal_mode 应为 wal，实际 ${JSON.stringify(journalRow)}`
  );
  const busyRow = await prodDb.prepare("PRAGMA busy_timeout").get();
  assert(
    Number(busyRow?.timeout ?? 0) === 5000,
    `场景6: 生产入口 busy_timeout 应为 5000，实际 ${JSON.stringify(busyRow)}`
  );
  const fkRow = await prodDb.prepare("PRAGMA foreign_keys").get();
  assert(
    Number(fkRow?.foreign_keys ?? 0) === 1,
    `场景6: 生产入口 foreign_keys 应为 ON，实际 ${JSON.stringify(fkRow)}`
  );

  assertSingleVersionRow(await knexVersionRows(prodDb), "场景6 生产入口首次");
  assert(
    appliedLogs(logs6a).length === 0,
    `场景6: 全新库不应有 Migration applied，实际 ${JSON.stringify(appliedLogs(logs6a))}`
  );
  const prodTables = (
    await prodDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
  )
    .map((row) => String(row.name))
    .sort();
  assert(
    JSON.stringify(prodTables) === JSON.stringify(expected),
    `场景6: 生产入口建表清单不符: ${prodTables}`
  );
  const structureBefore6 = await knexStructure(prodDb);

  // 第二次：生产里就是「重启后同一个进程重新初始化」，直接再调一次生产入口函数
  let prodDbAgain = null;
  const logs6b = await captureLogs(async () => {
    prodDbAgain = await getProdDb();
  });
  assert(prodDbAgain === prodDb, "场景6: 生产入口 getDb() 应为单例（两次调用同一实例）");
  assert(
    appliedLogs(logs6b).length === 0,
    `场景6: 第二次初始化不应出现 Migration applied，实际 ${JSON.stringify(appliedLogs(logs6b))}`
  );
  assertSingleVersionRow(await knexVersionRows(prodDb), "场景6 生产入口第二次");
  assert((await knexStructure(prodDb)) === structureBefore6, "场景6: 两次初始化之间表结构发生变化");
  console.log(
    `✅ 场景6 生产入口 getDb() 连续两次: 单例、WAL/busy_timeout/外键就位、单行 v${KNEX_SCHEMA_VERSION}、第二次无 Migration applied`
  );

  // --- 场景 7：被污染库（生产入口，生产重启路径 = initializeSchema）---
  await polluteKnexVersion(prodDb, [2, 3, 3]);
  const logs7a = await captureLogs(async () => {
    await initializeSchema(prodDb);
  });
  assertSingleVersionRow(await knexVersionRows(prodDb), "场景7 [2,3,3]");
  console.log(
    `✅ 场景7a 生产入口被污染库 [2,3,3] → 单行 v${KNEX_SCHEMA_VERSION}（日志: ${JSON.stringify(logs7a)}）`
  );

  await polluteKnexVersion(prodDb, [2, 2]);
  const logs7b = await captureLogs(async () => {
    await initializeSchema(prodDb);
  });
  assertSingleVersionRow(await knexVersionRows(prodDb), "场景7 [2,2]");
  assert(
    appliedLogs(logs7b).some((line) => line.includes("v3")),
    `场景7: [2,2] 应重跑 v3（建表幂等），实际 ${JSON.stringify(appliedLogs(logs7b))}`
  );
  console.log("✅ 场景7b 生产入口被污染库 [2,2] → v3 重复执行不报错、收敛单行");

  // --- 场景 8：并发两次初始化（**两个模块图** = 生产里 Next 与 app-server 各一份）---
  // 生产是「一个进程两个模块图」：`server/app-server.mjs`（node 侧）与 Next 打包出来的
  // 服务端代码各 import 一份 db-shared.mjs，模块作用域互不可见、各自一份 knex。
  // 这里用带 query 的动态 import 造出第二个模块实例（共享同一个 globalThis），
  // 复现真实形态：两边同时首次取库，必须只建一次表、只跑一次迁移。
  const dir4 = mkdtempSync(join(tmpdir(), "db-prod-concurrent-test-"));
  const concurrentPath = join(dir4, "concurrent.db");
  process.env.SQLITE_PATH = concurrentPath;
  await closeDb();
  const graphA = await import("../server/db-shared.mjs");
  const graphB = await import(`../server/db-shared.mjs?graph=2&t=${Date.now()}`);
  const logs8 = await captureLogs(async () => {
    await Promise.all([graphA.getDb(), graphB.getDb()]);
  });
  const dbA = await graphA.getDb();
  const dbB = await graphB.getDb();
  assert(
    appliedLogs(logs8).filter((line) => line.includes(`v${KNEX_SCHEMA_VERSION}`)).length <= 1,
    `场景8: 并发初始化不应重复跑 v${KNEX_SCHEMA_VERSION}，实际 ${JSON.stringify(appliedLogs(logs8))}`
  );
  assert(
    appliedLogs(logs8).filter((line) => line.includes("v1 ")).length <= 1,
    `场景8: 并发初始化不应重复跑 v1（RENAME 会撞车），实际 ${JSON.stringify(appliedLogs(logs8))}`
  );
  assertSingleVersionRow(await knexVersionRows(dbA), "场景8 并发（模块图 A）");
  const tables8 = (
    await dbA
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
  ).length;
  assert(tables8 === expected.length, `场景8: 并发初始化后表数应为 ${expected.length}，实际 ${tables8}`);
  assert(dbA === dbB, "场景8: 两个模块图应共享同一个初始化结果（globalThis single-flight）");
  await closeDb();
  console.log("✅ 场景8 并发两次生产入口初始化（两个模块图）: 单行、无重复迁移、共享初始化");

  // 关掉生产入口的连接池：不关脚本不会自己退出（池里挂着句柄）。
  await closeDb();
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
  rmSync(dir3, { recursive: true, force: true });
  rmSync(dir4, { recursive: true, force: true });
  console.log("🎉 schema 验证全部通过");
}

// ==================== 三库脚手架（--dialect / --matrix） ====================

/** 一次性测试库命名前缀（共享实例红线：只准碰 meeting_asr_ci_*） */
export const CI_DB_PREFIX = "meeting_asr_ci_";

/** 期望的基线表清单（createTables 产出，含 schema_version） */
const EXPECTED_TABLES = [
  "app_settings", "asr_capture_events", "asr_capture_sessions", "asr_hotwords",
  "audit_logs", "auth_sessions", "llm_prompt_templates", "meeting_asr_results",
  "meeting_llm_results", "meeting_send_records", "meetings", "roles",
  "schema_version", "user_roles", "users", "meeting_audio_recordings",
].sort();

export function assertSafeDbName(name) {
  if (!name.startsWith(CI_DB_PREFIX)) {
    throw new Error(
      `拒绝操作库 ${name}：三库脚手架只允许建/删 ${CI_DB_PREFIX}* 的一次性库（共享实例红线）`
    );
  }
}

/** 用同一套连接参数连到管理库（mssql: master / mysql: mysql）执行一句 DDL */
async function withAdminKnex(dbType, fn) {
  const target = process.env.DB_NAME;
  process.env.DB_NAME = dbType === "mysql" ? "mysql" : "master";
  const adminKnex = createKnexInstance(dbType);
  try {
    return await fn(adminKnex);
  } finally {
    process.env.DB_NAME = target;
    await adminKnex.destroy().catch(() => {});
  }
}

export async function createThrowawayDatabase(dbType, dbName) {
  assertSafeDbName(dbName);
  await withAdminKnex(dbType, (knex) =>
    knex.raw(
      dbType === "mysql"
        ? `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`
        : `CREATE DATABASE [${dbName}]`
    )
  );
}

export async function dropThrowawayDatabase(dbType, dbName) {
  if (!dbName.startsWith(CI_DB_PREFIX)) return;
  await withAdminKnex(dbType, (knex) =>
    knex.raw(
      dbType === "mysql"
        ? `DROP DATABASE IF EXISTS \`${dbName}\``
        : `DROP DATABASE IF EXISTS [${dbName}]`
    )
  );
}

/** 跨库表清单（替代 sqlite_master） */
async function listTableNames(db) {
  if (db.dbType === "sqlite") {
    const rows = await db.knex.raw(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    return extractRows(rows).map((row) => String(row.name)).sort();
  }
  if (db.dbType === "mysql") {
    const rows = await db.knex.raw(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
    );
    return extractRows(rows).map((row) => String(row.name)).sort();
  }
  const rows = await db.knex.raw(
    "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'"
  );
  return extractRows(rows).map((row) => String(row.name)).sort();
}

/** 跨库索引清单（替代 sqlite_master 的 type='index'） */
async function listIndexNames(db) {
  if (db.dbType === "sqlite") {
    const rows = await db.knex.raw(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    );
    return extractRows(rows).map((row) => String(row.name)).sort();
  }
  if (db.dbType === "mysql") {
    const rows = await db.knex.raw(
      `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME LIKE 'idx_%'`
    );
    return extractRows(rows).map((row) => String(row.name)).sort();
  }
  // 注意：sys.indexes 里还有 sys schema 内部表的索引（idx_groupid/idx_lcid/…），
  // 必须 JOIN sys.tables 才只看业务表（实测不 join 会多出 4 条）。
  const rows = await db.knex.raw(
    `SELECT i.name AS name FROM sys.indexes i
     JOIN sys.tables t ON t.object_id = i.object_id
     WHERE i.name LIKE 'idx_%'`
  );
  return extractRows(rows).map((row) => String(row.name)).sort();
}

async function versionRow(db) {
  const row = await db
    .prepare("SELECT MAX(version) AS max_version, COUNT(*) AS row_count FROM schema_version")
    .get();
  return { maxVersion: Number(row.max_version), rowCount: Number(row.row_count) };
}

/**
 * 生产入口 getDb() 在本方言上必须能初始化 + 冒烟（#54 对 mysql/mssql 的硬要求）。
 *
 * 这一步是「测的那条 = 跑的那条」的方言版：`--dialect` 前面的套件走的是脚本自建的
 * knex + AsyncDb，而这里走的是运行时真正的入口（server/db-shared.mjs 的 getDb()），
 * 顺带证明 SQLite 专属 PRAGMA 的 `DB_TYPE=sqlite` 条件化是必需的（去掉它 mssql 会挂）。
 */
async function runProductionEntryCheck(dbType) {
  const { getDb, closeDb } = await import("../server/db-shared.mjs");
  const prodDb = await getDb();
  try {
    assert(prodDb.dbType === dbType, `生产入口 dbType 应为 ${dbType}，实际 ${prodDb.dbType}`);
    const tables = await listTableNames(prodDb);
    assert(
      JSON.stringify(tables) === JSON.stringify(EXPECTED_TABLES),
      `生产入口建表清单不符: ${tables.length} 张 ${tables.join(", ")}`
    );
    const version = await versionRow(prodDb);
    assert(
      version.rowCount === 1 && version.maxVersion === KNEX_SCHEMA_VERSION,
      `生产入口版本记账应为单行 v${KNEX_SCHEMA_VERSION}，实际 MAX=${version.maxVersion} COUNT=${version.rowCount}`
    );
    console.log(
      `✅ 生产入口 getDb() 在 ${dbType} 上初始化 OK — ${tables.length} 张表 + 单行 v${KNEX_SCHEMA_VERSION}`
    );
  } finally {
    await closeDb();
  }
}

/** 单方言套件：基线建表 → 建索引 → 迁移到 SCHEMA_VERSION → 版本记账单行 → 二次幂等 */
async function runDialectSuite(db, dbType) {
  const check = (name, condition, detail) => {
    if (!condition) throw new Error(`${name} 失败: ${detail}`);
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // --- 1. 基线建表 + 建索引 + 迁移收敛 + 版本记账单行 ---
  await initializeSchema(db);
  const tables = await listTableNames(db);
  check(
    "基线建表 16 张表齐全",
    JSON.stringify(tables) === JSON.stringify(EXPECTED_TABLES),
    `${tables.length} 张: ${tables.join(", ")}`
  );

  const indexes = await listIndexNames(db);
  const missingIndexes = INDEXES.map((index) => index.name).filter(
    (name) => !indexes.includes(name)
  );
  check(
    "建索引 12 条齐全",
    missingIndexes.length === 0,
    missingIndexes.length ? `缺: ${missingIndexes.join(", ")}` : `${indexes.length} 条`
  );

  const audioColumns = await listTableColumns(db, "meeting_audio_recordings");
  check(
    "列探测（listTableColumns）跨库可用",
    audioColumns.length === 15,
    `meeting_audio_recordings ${audioColumns.length} 列`
  );

  let version = await versionRow(db);
  check(
    "迁移到 SCHEMA_VERSION + 版本记账单行",
    version.rowCount === 1 && version.maxVersion === KNEX_SCHEMA_VERSION,
    `MAX(version)=${version.maxVersion}, COUNT(*)=${version.rowCount}`
  );

  // --- 2. 二次幂等：不得重复迁移、表/索引集合不变 ---
  const tablesBefore = JSON.stringify(tables);
  const indexesBefore = JSON.stringify(indexes);
  const logs2 = await captureLogs(() => initializeSchema(db));
  check(
    "二次幂等：无 Migration applied",
    appliedLogs(logs2).length === 0,
    appliedLogs(logs2).length ? JSON.stringify(appliedLogs(logs2)) : "0 条"
  );
  check(
    "二次幂等：表/索引集合不变",
    JSON.stringify(await listTableNames(db)) === tablesBefore &&
      JSON.stringify(await listIndexNames(db)) === indexesBefore,
    "结构未变"
  );

  // --- 3. 真实迁移循环：污染 [2,2] → 重跑 v3 + v4 → 单行 ---
  await db.prepare("DELETE FROM schema_version").run();
  for (const value of [2, 2]) {
    await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(value);
  }
  const logs3 = await captureLogs(() => initializeSchema(db));
  version = await versionRow(db);
  const applied3 = appliedLogs(logs3);
  check(
    "迁移循环 v3+v4 重跑（含事务内的记账写入）",
    applied3.some((line) => line.includes("v3")) &&
      applied3.some((line) => line.includes(`v${KNEX_SCHEMA_VERSION}`)) &&
      version.rowCount === 1 &&
      version.maxVersion === KNEX_SCHEMA_VERSION,
    `日志 ${applied3.length} 条, 单行 v${version.maxVersion}`
  );

  // --- 3b. 事务并发回归（issue #54）：三库都跑 ---
  await runTransactionConcurrencySuite(db, dbType);

  // --- 4. 嵌套事务语义（issue #55 D5：三库都跑） ---
  //    #54 时 sqlite/mysql 的嵌套 savepoint 有独立缺陷（`no such savepoint: sp_1`），
  //    当时只在 mssql 上跑。 #55 把 savepoint 发在事务连接上（knex 嵌套事务），
  //    三库都断言「内层回滚只影响内层」。
  {
    await db.prepare("DELETE FROM schema_version").run();
    await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(KNEX_SCHEMA_VERSION);

    // 4a. 内层失败只回滚到内层，外层照常提交
    await db.withTransaction(async (tx) => {
      await tx.prepare("INSERT INTO schema_version (version) VALUES (?)").run(10);
      try {
        await tx.withTransaction(async (tx2) => {
          await tx2.prepare("INSERT INTO schema_version (version) VALUES (?)").run(11);
          throw new Error("inner-rollback");
        });
      } catch {
        // 内层异常在外层被吞掉 → 外层应提交
      }
      await tx.prepare("INSERT INTO schema_version (version) VALUES (?)").run(12);
    });
    const afterInner = (
      await db.prepare("SELECT version FROM schema_version ORDER BY version").all()
    ).map((row) => Number(row.version));
    check(
      "嵌套事务：内层失败只回滚内层（外层提交）",
      JSON.stringify(afterInner) === JSON.stringify([KNEX_SCHEMA_VERSION, 10, 12]),
      `剩余行 ${JSON.stringify(afterInner)}（11 应被回滚掉）`
    );

    // 4b. 内层抛错穿透外层 → 整体回滚
    await db.prepare("DELETE FROM schema_version").run();
    await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(KNEX_SCHEMA_VERSION);
    let outerThrew = false;
    try {
      await db.withTransaction(async (tx) => {
        await tx.prepare("INSERT INTO schema_version (version) VALUES (?)").run(20);
        await tx.withTransaction(async () => {
          throw new Error("inner-propagate");
        });
      });
    } catch {
      outerThrew = true;
    }
    const afterOuter = (
      await db.prepare("SELECT version FROM schema_version ORDER BY version").all()
    ).map((row) => Number(row.version));
    check(
      "嵌套事务：内层抛错穿透后外层整体回滚",
      outerThrew && JSON.stringify(afterOuter) === JSON.stringify([KNEX_SCHEMA_VERSION]),
      `剩余行 ${JSON.stringify(afterOuter)}（20 应被回滚掉）`
    );
  }
}

/** --dialect：单方言套件（DB_TYPE 决定目标；mysql/mssql 自建自删一次性库） */
async function mainDialect({ allowSkip = false } = {}) {
  const dbType = getDbType();
  console.log(`[dialect] 目标方言 db_type=${dbType}`);
  let tempDir = null;
  let dbName = null;
  let knex = null;

  if (dbType === "sqlite") {
    tempDir = mkdtempSync(join(tmpdir(), "db-dialect-test-"));
    process.env.SQLITE_PATH = join(tempDir, "dialect.db");
    console.log(`[dialect] sqlite 临时库: ${process.env.SQLITE_PATH}`);
  } else {
    dbName = `${CI_DB_PREFIX}schema_${Date.now().toString(36)}_${process.pid}`;
    process.env.DB_NAME = dbName;
    console.log(`[dialect] 一次性库: ${dbName}`);
    try {
      await createThrowawayDatabase(dbType, dbName);
    } catch (error) {
      console.log(
        `SKIP: 目标库不可达或建库失败（db_type=${dbType}, db=${dbName}）: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      console.log("RESULT: SKIP");
      // 默认严格：SKIP 一律非 0（矩阵父进程据此归类 SKIP 项）。--allow-skip 只给手动放行用，
      // 矩阵从不向子进程透传该参数，避免子进程的 SKIP 被误判成 PASS。
      process.exitCode = allowSkip ? 0 : 3;
      return;
    }
  }

  try {
    knex = createKnexInstance(dbType);
    const db = new AsyncDb(knex, dbType);
    await db.knex.raw("SELECT 1");
    await runDialectSuite(db, dbType);
    await runProductionEntryCheck(dbType);
    console.log(`🎉 方言套件全部通过（db_type=${dbType}）`);
    console.log("RESULT: PASS");
  } catch (error) {
    console.error("❌", error instanceof Error ? error.message : error);
    console.log("RESULT: FAIL");
    process.exitCode = 1;
  } finally {
    if (knex) await knex.destroy().catch(() => {});
    if (dbName) {
      await dropThrowawayDatabase(dbType, dbName).catch((error) => {
        console.error(`[dialect] DROP 失败: ${error.message}`);
        process.exitCode = 1;
      });
      console.log(`[dialect] 已 DROP 一次性库 ${dbName}`);
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 子进程执行（矩阵用）：捕获输出，按退出码归类 PASS/SKIP/FAIL */
function runChild(args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = [];
    const collect = (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) {
          lines.push(line);
          console.log(`    │ ${line}`);
        }
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => {
      const verdict = code === 0 ? "PASS" : code === 3 ? "SKIP" : "FAIL";
      const skipLine = lines.find((line) => line.startsWith("SKIP:"));
      resolve({
        verdict,
        code,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
        reason: skipLine ? skipLine.replace(/^SKIP:\s*/, "") : null,
      });
    });
  });
}

/** --matrix：sqlite(两驱动) + mariadb + mssql 各跑一遍 schema 套件与语义锁 */
async function mainMatrix({ allowSkip = false } = {}) {
  const self = fileURLToPath(import.meta.url);
  const semanticScript = join(process.cwd(), "scripts", "db-semantic-test.mjs");
  const mysqlPassword = process.env.CI_MYSQL_PASSWORD || "";
  const mssqlPassword = process.env.CI_MSSQL_PASSWORD || "";
  const mysqlEnv = {
    DB_TYPE: "mysql",
    DB_HOST: process.env.CI_MYSQL_HOST || "mariadb",
    DB_PORT: process.env.CI_MYSQL_PORT || "3306",
    DB_USER: process.env.CI_MYSQL_USER || "root",
    DB_PASSWORD: mysqlPassword,
  };
  const mssqlEnv = {
    DB_TYPE: "mssql",
    DB_HOST: process.env.CI_MSSQL_HOST || "host.docker.internal",
    DB_PORT: process.env.CI_MSSQL_PORT || "1433",
    DB_USER: process.env.CI_MSSQL_USER || "sa",
    DB_PASSWORD: mssqlPassword,
  };

  const targets = [
    {
      label: "sqlite（生产入口 getDb() → better-sqlite3，legacy 已退役）",
      jobs: [
        { name: "schema/迁移全量", args: [self], env: {} },
        { name: "语义锁", args: [semanticScript], env: {} },
      ],
    },
    {
      label: `mariadb（${mysqlEnv.DB_HOST}:${mysqlEnv.DB_PORT}）`,
      jobs: [
        { name: "schema/迁移方言套件", args: [self, "--dialect"], env: mysqlEnv },
        { name: "语义锁", args: [semanticScript], env: mysqlEnv },
      ],
    },
    {
      label: `mssql（${mssqlEnv.DB_HOST}:${mssqlEnv.DB_PORT}）`,
      jobs: [
        { name: "schema/迁移方言套件", args: [self, "--dialect"], env: mssqlEnv },
        { name: "语义锁", args: [semanticScript], env: mssqlEnv },
      ],
    },
  ];

  const summary = [];
  for (const target of targets) {
    console.log(`\n[matrix] ===== ${target.label} =====`);
    for (const job of target.jobs) {
      console.log(`[matrix] ▶ ${job.name}`);
      const result = await runChild(job.args, job.env);
      summary.push({ target: target.label, job: job.name, ...result });
      console.log(`[matrix] ◀ ${job.name}: ${result.verdict}（${result.seconds}s）`);
    }
  }

  console.log("\n[matrix] ===== 汇总 =====");
  for (const item of summary) {
    const reason = item.reason ? ` — ${item.reason}` : "";
    console.log(
      `${item.verdict === "PASS" ? "✅" : item.verdict === "SKIP" ? "⏭" : "❌"} ${item.target} / ${item.job}: ${item.verdict}（${item.seconds}s）${reason}`
    );
  }
  const failed = summary.filter((item) => item.verdict === "FAIL");
  const skipped = summary.filter((item) => item.verdict === "SKIP");
  console.log(
    `[matrix] ${summary.length} 项：PASS ${summary.length - failed.length - skipped.length} / SKIP ${skipped.length} / FAIL ${failed.length}`
  );
  if (failed.length > 0) {
    process.exitCode = 1;
    console.log("[matrix] ❌ 存在 FAIL 项，矩阵失败");
  } else if (skipped.length > 0) {
    const skipList = skipped.map((item) => `${item.target} / ${item.job}`).join("；");
    if (allowSkip) {
      console.log(`[matrix] ⏭ 存在 SKIP 项，已由 --allow-skip 显式放行（退出码 0）：${skipList}`);
    } else {
      // 默认严格：SKIP 不许伪装成全绿（6 项里只跑通 sqlite、外部靶子不可达时 CI 必须红）
      process.exitCode = 1;
      console.log(
        `[matrix] ❌ 存在 SKIP 项，未覆盖的方言不算通过（默认严格，退出码非 0）：${skipList}`
      );
      console.log("[matrix]    如确认要放行，请显式追加 --allow-skip");
    }
  }
}

/** 允许的命令行参数（未知参数一律报错，不静默忽略） */
const KNOWN_FLAGS = new Map([
  ["--matrix", "三库矩阵：sqlite(两驱动) + mariadb + mssql 各跑一遍 schema 套件与语义锁"],
  ["--dialect", "单方言套件（目标由 DB_TYPE / DB_HOST / DB_NAME 等决定）"],
  ["--allow-skip", "存在 SKIP 项时仍以退出码 0 结束（默认：存在 SKIP 即失败）"],
]);

function parseArgs(argv) {
  const flags = new Set();
  const unknown = [];
  for (const arg of argv) {
    if (KNOWN_FLAGS.has(arg)) flags.add(arg);
    else unknown.push(arg);
  }
  return { flags, unknown };
}

function printUsage() {
  console.error("[args] 可用参数：");
  for (const [flag, description] of KNOWN_FLAGS) {
    console.error(`  ${flag.padEnd(14)} ${description}`);
  }
  console.error("  （不带参数）    sqlite 全量套件（两种驱动都跑）");
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const { flags, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`❌ 未知参数: ${unknown.join(" ")}`);
    printUsage();
    console.log("RESULT: FAIL");
    process.exit(2);
  }
  if (flags.has("--matrix") && flags.has("--dialect")) {
    console.error("❌ --matrix 与 --dialect 不能同时使用");
    printUsage();
    console.log("RESULT: FAIL");
    process.exit(2);
  }

  const options = { allowSkip: flags.has("--allow-skip") };
  const mode = flags.has("--matrix") ? mainMatrix : flags.has("--dialect") ? mainDialect : main;
  mode(options).catch((e) => {
    console.error("❌", e);
    console.log("RESULT: FAIL");
    process.exit(1);
  });
}
