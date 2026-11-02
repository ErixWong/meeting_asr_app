/**
 * 方言语法套件（issue #55b / PR-B③b）
 *
 * 目标：把「方言敏感语法」从业务代码里清掉之后，**改造后的那几条 SQL 在三个库上真的能跑**。
 * 本套件直接 import 生产用的三个函数（`insertIgnore` / `upsert` / `addColumnIfAbsent`），
 * 不复制 SQL 文本——「测的那条 = 跑的那条」。
 *
 * 覆盖（三库同一套断言）：
 *   A `insertIgnore()`：SQLite `INSERT OR IGNORE` / MariaDB `INSERT IGNORE` /
 *     MSSQL `INSERT ... SELECT ... WHERE NOT EXISTS` —— 首次插入生效、重复键被忽略、
 *     批量里「部分重复」只插进去非重复的那些，且受影响行数三库一致（0/1/2）。
 *   B `upsert()`：SQLite `ON CONFLICT DO UPDATE` / MariaDB `ON DUPLICATE KEY UPDATE` /
 *     MSSQL `UPDATE ...; IF @@ROWCOUNT = 0 INSERT ...` —— 不存在则插入、存在则只覆盖
 *     指定列（未列出的列保持原值）、`{ column, literal }` 形式的字面量覆盖（`'recording'` / `NULL`）。
 *   C `addColumnIfAbsent()`（= 生产 `migrateAuthSchema` → `ensureColumn` 的实现）：
 *     列探测跨库（不再用 `PRAGMA table_info`）、`ADD COLUMN` 关键字与列类型按方言翻译、
 *     幂等（第二次返回 false）。
 *   D 分页/单行片段（`limitFragment` / `singleRowFragment`）：`LIMIT n` vs `TOP n` /
 *     `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` 在子查询与列表两种位置都合法。
 *   E 角色迁移的等价写法（原 `UPDATE OR IGNORE user_roles`）：用 `insertIgnore()` + 普通
 *     `DELETE` 组合替代，证明「同一用户已有新角色」的重复行能被正确收敛，且旧角色行删得掉
 *     （不撞外键）。
 *
 * 运行模式（未知参数一律报错退出）：
 *   node scripts/db-dialect-test.mjs              # sqlite（默认，临时库）
 *   node scripts/db-dialect-test.mjs --dialect    # 单方言，目标由 DB_TYPE / DB_HOST / DB_NAME 决定
 *   --allow-skip：目标库不可达时仍以退出码 0 结束（默认严格：SKIP ⇒ 退出码 3）
 *
 * 库生命周期：mysql / mssql 只建/删 `meeting_asr_ci_*` 一次性库（共享实例红线），
 * **DROP 放在 finally**；矩阵（`npm run db:test-parity`）把本脚本作为一个 job 挂进每个目标，
 * 语义与 schema/语义锁/事务套件一致——**任何 SKIP 即失败**。
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { createKnexInstance, getDbType } from "../server/db/index.mjs";
import {
  AsyncDb,
  addColumnIfAbsent,
  dialectColumnDefinition,
  limitFragment,
  listTableColumns,
  singleRowFragment,
} from "../server/db/async-db.mjs";
import { insertIgnore, upsert } from "../server/db/insert-ignore.mjs";
import { initializeSchema } from "../server/db/schema.mjs";
import {
  CI_DB_PREFIX,
  createThrowawayDatabase,
  dropThrowawayDatabase,
} from "./db-schema-test.mjs";

const PROBE_TABLE = "dialect_probe";

/** 断言失败 = 用例失败（与 db-schema-test / db-tx-test 同风格） */
function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name} 失败: ${detail}`);
  }
  console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
}

const describeError = (error) => (error instanceof Error ? error.message : String(error));
const nowIso = () => new Date().toISOString();

/** app_settings 的单行投影（只取断言要用的列） */
async function readSetting(db, section, mark) {
  return await db
    .prepare("SELECT item_value, item_title FROM app_settings WHERE item_section = ? AND item_mark = ?")
    .get(section, mark);
}

async function countSetting(db, section) {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM app_settings WHERE item_section = ?")
    .get(section);
  return Number(row?.count ?? 0);
}

function settingRow(mark, value, title = "标题") {
  return {
    item_section: "ci",
    item_mark: mark,
    item_title: title,
    item_description: "",
    item_value: value,
    updated_at: nowIso(),
  };
}

// ==================== 套件 ====================

async function runSuite(db, dbType) {
  await initializeSchema(db);
  await db.knex.schema.dropTableIfExists(PROBE_TABLE).catch(() => {});

  try {
    // ---------- A. insertIgnore ----------
    const a1 = await insertIgnore(db, "app_settings", settingRow("probe", "v1"), ["item_section", "item_mark"]);
    const readA1 = await readSetting(db, "ci", "probe");
    check(
      "A1 insertIgnore 首次插入：受影响 1 行、值落库",
      Number(a1) === 1 && readA1?.item_value === "v1",
      `affected=${a1} value=${readA1?.item_value}`
    );

    const a2 = await insertIgnore(db, "app_settings", settingRow("probe", "v2", "不该覆盖"), [
      "item_section",
      "item_mark",
    ]);
    const readA2 = await readSetting(db, "ci", "probe");
    check(
      "A2 insertIgnore 重复键被忽略：受影响 0 行、原值不变",
      Number(a2) === 0 && readA2?.item_value === "v1" && readA2?.item_title === "标题",
      `affected=${a2} value=${readA2?.item_value} title=${readA2?.item_title}`
    );

    const a3 = await insertIgnore(
      db,
      "app_settings",
      [settingRow("probe", "dup"), settingRow("probe-b", "b1"), settingRow("probe-c", "c1")],
      ["item_section", "item_mark"]
    );
    check(
      "A3 insertIgnore 批量：只插入非重复的两行",
      Number(a3) === 2 && (await countSetting(db, "ci")) === 3,
      `affected=${a3} 行数=${await countSetting(db, "ci")}`
    );

    // ---------- B. upsert ----------
    const b1 = await upsert(db, "app_settings", settingRow("upsert", "u1"), ["item_section", "item_mark"], [
      "item_title",
      "item_value",
      "updated_at",
    ]);
    const readB1 = await readSetting(db, "ci", "upsert");
    check(
      "B1 upsert 键不存在：插入生效",
      readB1?.item_value === "u1" && (await countSetting(db, "ci")) === 4,
      `value=${readB1?.item_value} affected=${b1}`
    );

    await upsert(db, "app_settings", settingRow("upsert", "u2", "新标题"), ["item_section", "item_mark"], [
      "item_title",
      "item_value",
      "updated_at",
    ]);
    const readB2 = await readSetting(db, "ci", "upsert");
    check(
      "B2 upsert 键已存在：覆盖指定列、行数仍为 1",
      readB2?.item_value === "u2" && readB2?.item_title === "新标题" && (await countSetting(db, "ci")) === 4,
      `value=${readB2?.item_value} title=${readB2?.item_title}`
    );

    // 覆盖列之外的列必须保持原值（created_at 不在 updateColumns 里）
    await upsert(
      db,
      "llm_prompt_templates",
      {
        id: "tpl-ci-probe",
        template_key: "ci_probe",
        template_name: "探针",
        template_type: "custom",
        content: "c1",
        description: "",
        status: "active",
        is_system: 0,
        created_at: "2020-01-01T00:00:00.000Z",
        updated_at: "2020-01-01T00:00:00.000Z",
      },
      ["id"],
      ["template_name", "content", "status", "updated_at"]
    );
    await upsert(
      db,
      "llm_prompt_templates",
      {
        id: "tpl-ci-probe",
        template_key: "ci_probe",
        template_name: "探针2",
        template_type: "custom",
        content: "c2",
        description: "",
        status: "active",
        is_system: 0,
        created_at: "2030-12-31T00:00:00.000Z",
        updated_at: nowIso(),
      },
      ["id"],
      ["template_name", "content", "status", "updated_at"]
    );
    const tpl = await db
      .prepare("SELECT template_name, content, created_at FROM llm_prompt_templates WHERE id = ?")
      .get("tpl-ci-probe");
    check(
      "B3 upsert 只覆盖指定列：created_at 保持首次插入值",
      tpl?.template_name === "探针2" &&
        tpl?.content === "c2" &&
        String(tpl?.created_at) === "2020-01-01T00:00:00.000Z",
      `name=${tpl?.template_name} created_at=${tpl?.created_at}`
    );

    // 字面量覆盖（'recording' / NULL）——生产 registerAudioRecording 的形态
    const audioRow = (rawPath, at) => ({
      id: `aud-ci-${at}`,
      capture_session_id: "cap-ci-probe",
      meeting_id: null,
      file_path: null,
      raw_file_path: rawPath,
      format: "mp3",
      status: "recording",
      bytes: 0,
      duration_seconds: 0,
      sample_rate: 16000,
      bitrate_kbps: null,
      error_message: null,
      created_at: at,
      updated_at: at,
      expires_at: null,
    });
    await upsert(db, "meeting_audio_recordings", audioRow("/tmp/a1.pcm", nowIso()), ["capture_session_id"], [
      "raw_file_path",
      "sample_rate",
      { column: "status", literal: "'recording'" },
      { column: "error_message", literal: "NULL" },
      "updated_at",
      "expires_at",
    ]);
    const insertedAudio = await db
      .prepare(
        "SELECT id, raw_file_path, status, error_message FROM meeting_audio_recordings WHERE capture_session_id = ?"
      )
      .get("cap-ci-probe");
    await db
      .prepare("UPDATE meeting_audio_recordings SET status = ?, error_message = ? WHERE capture_session_id = ?")
      .run("ready", "boom", "cap-ci-probe");
    await upsert(db, "meeting_audio_recordings", audioRow("/tmp/a2.pcm", nowIso()), ["capture_session_id"], [
      "raw_file_path",
      "sample_rate",
      { column: "status", literal: "'recording'" },
      { column: "error_message", literal: "NULL" },
      "updated_at",
      "expires_at",
    ]);
    const updatedAudio = await db
      .prepare(
        "SELECT id, raw_file_path, status, error_message FROM meeting_audio_recordings WHERE capture_session_id = ?"
      )
      .get("cap-ci-probe");
    const audioCount = Number(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM meeting_audio_recordings WHERE capture_session_id = ?")
          .get("cap-ci-probe")
      )?.count ?? 0
    );
    check(
      "B4 upsert 字面量覆盖：status 回到 'recording'、error_message 回 NULL、id 不被改写",
      insertedAudio?.status === "recording" &&
        updatedAudio?.status === "recording" &&
        updatedAudio?.error_message === null &&
        updatedAudio?.raw_file_path === "/tmp/a2.pcm" &&
        updatedAudio?.id === insertedAudio?.id &&
        audioCount === 1,
      `status=${updatedAudio?.status} err=${updatedAudio?.error_message} path=${updatedAudio?.raw_file_path} 行数=${audioCount}`
    );

    // ---------- C. 列探测 + 幂等补列 ----------
    const columns = await listTableColumns(db, "app_settings");
    check(
      "C1 listTableColumns 跨库列探测（app_settings）",
      ["item_section", "item_mark", "item_value"].every((column) => columns.includes(column)),
      columns.join(", ")
    );

    await db.knex.schema.createTable(PROBE_TABLE, (t) => {
      t.string("id", 64).primary();
    });
    const added = await addColumnIfAbsent(db, PROBE_TABLE, "must_change_password", "INTEGER NOT NULL DEFAULT 0");
    const probeColumns = await listTableColumns(db, PROBE_TABLE);
    await db.prepare(`INSERT INTO ${PROBE_TABLE} (id) VALUES (?)`).run("probe-1");
    const probeRow = await db.prepare(`SELECT must_change_password FROM ${PROBE_TABLE} WHERE id = ?`).get("probe-1");
    check(
      "C2 addColumnIfAbsent 新增 INTEGER NOT NULL DEFAULT 0（方言类型翻译 + ADD COLUMN 关键字）",
      added === true && probeColumns.includes("must_change_password") && Number(probeRow?.must_change_password) === 0,
      `added=${added} columns=${probeColumns.join(",")} default=${probeRow?.must_change_password}`
    );

    const addedAgain = await addColumnIfAbsent(db, PROBE_TABLE, "must_change_password", "INTEGER NOT NULL DEFAULT 0");
    check("C3 addColumnIfAbsent 幂等：第二次返回 false", addedAgain === false, `addedAgain=${addedAgain}`);

    const mssqlDef = dialectColumnDefinition("mssql", "INTEGER NOT NULL DEFAULT 0");
    const mssqlText = dialectColumnDefinition("mssql", "TEXT");
    const sqliteDef = dialectColumnDefinition("sqlite", "INTEGER NOT NULL DEFAULT 0");
    check(
      "C4 dialectColumnDefinition：mssql 翻译 INTEGER/TEXT，其余方言原样透传",
      mssqlDef === "INT NOT NULL DEFAULT 0" &&
        mssqlText === "NVARCHAR(MAX)" &&
        sqliteDef === "INTEGER NOT NULL DEFAULT 0",
      `mssql=${mssqlDef} | ${mssqlText} ; sqlite=${sqliteDef}`
    );

    // ---------- D. 分页 / 单行片段 ----------
    const paged = await db
      .prepare(`SELECT item_mark FROM app_settings ORDER BY item_mark ${limitFragment(dbType, 2)}`)
      .all();
    check("D1 limitFragment 列表分页取 2 行", paged.length === 2, `rows=${paged.map((r) => r.item_mark).join(",")}`);

    const { top, limit } = singleRowFragment(dbType, 1);
    const picked = await db
      .prepare(
        `SELECT (SELECT ${top}item_value FROM app_settings WHERE item_section = ? ORDER BY item_mark ${limit}) AS picked`
      )
      .get("ci");
    check(
      "D2 singleRowFragment 子查询取单值（mssql: TOP 1 / 其余: LIMIT 1）",
      picked?.picked === "v1",
      `picked=${picked?.picked}`
    );

    // ---------- E. 角色迁移等价写法（原 UPDATE OR IGNORE user_roles） ----------
    const at = nowIso();
    for (const [id, account] of [
      ["user-ci-1", "ci-user-1"],
      ["user-ci-2", "ci-user-2"],
    ]) {
      await db
        .prepare(
          "INSERT INTO users (id, account_name, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(id, account, account, "active", at, at);
    }
    for (const [id, key] of [
      ["role-ci-old", "ci_legacy_admin"],
      ["role-ci-new", "ci_system_admin"],
    ]) {
      await db
        .prepare("INSERT INTO roles (id, role_key, role_name, created_at) VALUES (?, ?, ?, ?)")
        .run(id, key, key, at);
    }
    // user-1 同时挂旧角色与新角色（迁移时冲突）；user-2 只挂旧角色
    await insertIgnore(
      db,
      "user_roles",
      [
        { id: "ur-1-old", user_id: "user-ci-1", role_id: "role-ci-old", created_at: at },
        { id: "ur-1-new", user_id: "user-ci-1", role_id: "role-ci-new", created_at: at },
        { id: "ur-2-old", user_id: "user-ci-2", role_id: "role-ci-old", created_at: at },
      ],
      ["user_id", "role_id"]
    );
    // 生产代码（admin-store seedIdentityDefaults）的等价写法：逐行按新角色 insertIgnore，再删旧行
    const legacyRows = await db
      .prepare("SELECT id, user_id, created_at FROM user_roles WHERE role_id = ?")
      .all("role-ci-old");
    for (const row of legacyRows) {
      await insertIgnore(
        db,
        "user_roles",
        { id: `ur-mig-${row.user_id}`, user_id: row.user_id, role_id: "role-ci-new", created_at: row.created_at },
        ["user_id", "role_id"]
      );
    }
    await db.prepare("DELETE FROM user_roles WHERE role_id = ?").run("role-ci-old");
    await db.prepare("DELETE FROM roles WHERE id = ?").run("role-ci-old");

    const rolesOfUser1 = (
      await db.prepare("SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id").all("user-ci-1")
    ).map((row) => String(row.role_id));
    const rolesOfUser2 = (
      await db.prepare("SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id").all("user-ci-2")
    ).map((row) => String(row.role_id));
    check(
      "E1 角色迁移：已有新角色的用户不重复、只有旧角色的用户被改到新角色、旧角色行可删（无外键报错）",
      JSON.stringify(rolesOfUser1) === JSON.stringify(["role-ci-new"]) &&
        JSON.stringify(rolesOfUser2) === JSON.stringify(["role-ci-new"]),
      `user1=${rolesOfUser1.join(",")} user2=${rolesOfUser2.join(",")}`
    );
  } finally {
    await db.knex.schema.dropTableIfExists(PROBE_TABLE).catch(() => {});
  }

  console.log(`🎉 方言语法套件全部通过（db_type=${dbType}）`);
}

async function mainDialect({ allowSkip = false } = {}) {
  const dbType = getDbType();
  let tempDir = null;
  let dbName = null;
  let knex = null;

  if (dbType === "sqlite") {
    tempDir = mkdtempSync(join(tmpdir(), "db-dialect-test-"));
    process.env.SQLITE_PATH = join(tempDir, "dialect.db");
    console.log(`[dialect-syntax] sqlite 临时库: ${process.env.SQLITE_PATH}`);
  } else {
    dbName = `${CI_DB_PREFIX}dialect_${Date.now().toString(36)}_${process.pid}`;
    process.env.DB_NAME = dbName;
    console.log(`[dialect-syntax] 一次性库: ${dbName}`);
    try {
      await createThrowawayDatabase(dbType, dbName);
    } catch (error) {
      console.log(
        `SKIP: 目标库不可达或建库失败（db_type=${dbType}, db=${dbName}）: ${describeError(error)}`
      );
      console.log("RESULT: SKIP");
      process.exitCode = allowSkip ? 0 : 3;
      return;
    }
  }

  try {
    knex = createKnexInstance(dbType);
    const db = new AsyncDb(knex, dbType);
    await db.knex.raw("SELECT 1");
    await runSuite(db, dbType);
    console.log("RESULT: PASS");
  } catch (error) {
    console.error("❌", describeError(error));
    console.log("RESULT: FAIL");
    process.exitCode = 1;
  } finally {
    // 关池 + DROP 都放 finally：任何异常路径都不留悬挂句柄与一次性库
    if (knex) await knex.destroy().catch(() => {});
    if (dbName) {
      await dropThrowawayDatabase(dbType, dbName).catch((error) => {
        console.error(`[dialect-syntax] DROP 失败: ${describeError(error)}`);
        process.exitCode = 1;
      });
      console.log(`[dialect-syntax] 已 DROP 一次性库 ${dbName}`);
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

const KNOWN_FLAGS = new Map([
  ["--dialect", "单方言套件（目标由 DB_TYPE / DB_HOST / DB_NAME 等决定）"],
  ["--allow-skip", "存在 SKIP 项时仍以退出码 0 结束（默认：SKIP 即退出码 3）"],
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

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const { flags, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`❌ 未知参数: ${unknown.join(" ")}`);
    console.error("[args] 可用参数：");
    for (const [flag, description] of KNOWN_FLAGS) console.error(`  ${flag.padEnd(14)} ${description}`);
    console.error("  （不带参数）    sqlite 套件（临时库）");
    console.log("RESULT: FAIL");
    process.exit(2);
  }
  mainDialect({ allowSkip: flags.has("--allow-skip") }).catch((error) => {
    console.error("❌", error);
    console.log("RESULT: FAIL");
    process.exit(1);
  });
}
