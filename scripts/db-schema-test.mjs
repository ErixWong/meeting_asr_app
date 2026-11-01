/**
 * schema 初始化/迁移验证（sqlite）
 *
 * 覆盖两条实现路径（issue #51 的教训：判据必须打到生产实际入口）：
 *   - legacy 路径：server/database-schema.mjs 的 initializeDatabase()
 *     —— 生产实际入口，经 server/db-shared.mjs 的 getDb() 调用
 *   - knex 路径：server/db/schema.mjs 的 initializeSchema()
 *     —— 脚本/新基建入口，与 legacy 必须保持同一版本号、同一效果
 *
 * 场景：
 *   1. 全新库初始化（knex）→ 16 张表 + schema_version = SCHEMA_VERSION（单行）
 *   2. 幂等（knex）：连续两次初始化 → 单行、第二次无 Migration applied、表结构不变
 *   3. 旧库迁移（knex）：构造 v0 旧结构 → 数据搬迁 + legacy 清理 + 录音表
 *   4. 被污染库（knex）：schema_version = [2,3,3] / [2,2] → 收敛成单行 = SCHEMA_VERSION
 *   5. 并发两次初始化（knex）：Promise.all → 单行、无重复迁移、不崩
 *   6. 生产入口（legacy getDb()）：连续两次 → 单行、第二次无 Migration applied
 *   7. 被污染库（legacy）：[2,3,3] / [2,2] → 收敛成单行 = SCHEMA_VERSION（v3 重复执行不报错）
 *   8. 并发两次初始化（legacy）：两个连接 Promise.all → 单行
 */
import { createKnexInstance } from "../server/db/index.mjs";
import { AsyncDb, listTableColumns } from "../server/db/async-db.mjs";
import { initializeSchema, SCHEMA_VERSION as KNEX_SCHEMA_VERSION } from "../server/db/schema.mjs";
import {
  initializeDatabase,
  SCHEMA_VERSION as LEGACY_SCHEMA_VERSION,
} from "../server/database-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

/** 两条路径的版本号必须一致（不许漂移） */
function assertSameSchemaVersion() {
  assert(
    KNEX_SCHEMA_VERSION === LEGACY_SCHEMA_VERSION,
    `两条路径的 SCHEMA_VERSION 漂移: knex=${KNEX_SCHEMA_VERSION} legacy=${LEGACY_SCHEMA_VERSION}`
  );
}

async function knexVersionRows(db) {
  const rows = await db.knex.raw("SELECT version FROM schema_version");
  return rows.map((row) => Number(row.version));
}

function legacyVersionRows(database) {
  return database
    .prepare("SELECT version FROM schema_version")
    .all()
    .map((row) => Number(row.version));
}

async function knexStructure(db) {
  const rows = await db.knex.raw(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  );
  return JSON.stringify(rows.map((row) => [row.type, row.name, row.sql]));
}

function legacyStructure(database) {
  const rows = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all();
  return JSON.stringify(rows.map((row) => [row.type, row.name, row.sql]));
}

/** 断言单行 + 值 = SCHEMA_VERSION（两条路径共用） */
function assertSingleVersionRow(rows, label) {
  assert(
    rows.length === 1,
    `${label}: schema_version 应恰好 1 行，实际 ${rows.length} 行 ${JSON.stringify(rows)}`
  );
  assert(
    rows[0] === LEGACY_SCHEMA_VERSION,
    `${label}: schema_version 应为 ${LEGACY_SCHEMA_VERSION}，实际 ${rows[0]}`
  );
}

/** 造「被本缺陷污染过的库」：把记账改写成给定的多行值 */
async function polluteKnexVersion(db, versions) {
  await db.prepare("DELETE FROM schema_version").run();
  for (const version of versions) {
    await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  }
}

function polluteLegacyVersion(database, versions) {
  database.prepare("DELETE FROM schema_version").run();
  for (const version of versions) {
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  }
}

async function main() {
  assertSameSchemaVersion();
  console.log(`[info] SCHEMA_VERSION = ${LEGACY_SCHEMA_VERSION}（两条路径一致）`);

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
  console.log(`✅ 场景1 全新库初始化: 16 张表 + schema_version=${LEGACY_SCHEMA_VERSION}（单行）`);

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
    `✅ 场景4a 被污染库 [2,3,3] → 单行 v${LEGACY_SCHEMA_VERSION}（日志: ${JSON.stringify(logs4)}）`
  );

  // 污染成 MAX < 3：v3 会被重复执行，必须仍然幂等不报错
  await polluteKnexVersion(db, [2, 2]);
  const logs4b = await captureLogs(async () => {
    await initializeSchema(db);
  });
  assertSingleVersionRow(await knexVersionRows(db), "场景4 [2,2]");
  assert(
    appliedLogs(logs4b).some((line) => line.includes("v3")) &&
      appliedLogs(logs4b).some((line) => line.includes(`v${LEGACY_SCHEMA_VERSION}`)),
    `场景4: [2,2] 应重跑 v3 与 v${LEGACY_SCHEMA_VERSION}，实际 ${JSON.stringify(appliedLogs(logs4b))}`
  );
  console.log("✅ 场景4b 被污染库 [2,2] → v3 重复执行不报错、收敛单行");

  // --- 场景 5：并发两次初始化（knex，同一进程 Promise.all）---
  await polluteKnexVersion(db, [2, 3, 3]);
  const logs5 = await captureLogs(async () => {
    await Promise.all([initializeSchema(db), initializeSchema(db)]);
  });
  assertSingleVersionRow(await knexVersionRows(db), "场景5 并发");
  assert(
    appliedLogs(logs5).filter((line) => line.includes(`v${LEGACY_SCHEMA_VERSION}`)).length <= 1,
    `场景5: 并发初始化不应重复跑 v${LEGACY_SCHEMA_VERSION}，实际 ${JSON.stringify(appliedLogs(logs5))}`
  );
  console.log("✅ 场景5 并发两次 initializeSchema: 单行、无重复迁移、无 savepoint 崩溃");

  await db.knex.destroy();

  // --- 场景 3：旧库迁移（knex）---
  const dir2 = mkdtempSync(join(tmpdir(), "db-migrate-test-"));
  process.env.SQLITE_PATH = join(dir2, "old.db");
  const db2 = new AsyncDb(createKnexInstance("sqlite"));
  // 构造 v0 旧结构（模拟真实旧库：所有表齐全，仅 meeting_llm_results 为旧结构）
  await db2.knex.raw(`CREATE TABLE meetings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, source_type TEXT NOT NULL,
    source_file_name TEXT, duration_seconds INTEGER, status TEXT NOT NULL,
    status_updated_at TEXT NOT NULL, last_error_message TEXT,
    created_by_user_id TEXT NOT NULL, created_by_user_name TEXT NOT NULL,
    created_by_user_email TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await db2.knex.raw(`CREATE TABLE meeting_asr_results (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, asr_provider TEXT NOT NULL,
    asr_setting_mark TEXT NOT NULL, asr_config_snapshot TEXT NOT NULL,
    capture_session_id TEXT NOT NULL, result_format TEXT NOT NULL,
    raw_payload TEXT NOT NULL, normalized_text TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await db2.knex.raw(`CREATE TABLE llm_prompt_templates (id TEXT PRIMARY KEY)`);
  await db2.knex.raw(`CREATE TABLE users (id TEXT PRIMARY KEY)`);
  await db2.knex.raw(`CREATE TABLE roles (id TEXT PRIMARY KEY, role_key TEXT NOT NULL, role_name TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await db2.knex.raw(`CREATE TABLE user_roles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role_id TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await db2.knex.raw(`CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
  await db2.knex.raw(`CREATE TABLE app_settings (item_section TEXT NOT NULL, item_mark TEXT NOT NULL, item_title TEXT NOT NULL, item_description TEXT NOT NULL, item_value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (item_section, item_mark))`);
  await db2.knex.raw(`CREATE TABLE asr_capture_sessions (capture_session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, asr_provider TEXT NOT NULL, asr_config_snapshot TEXT NOT NULL, hotwords_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  await db2.knex.raw(`CREATE TABLE audit_logs (id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, actor_account_name TEXT NOT NULL, actor_display_name TEXT NOT NULL, action_type TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, resource_name TEXT, request_id TEXT, result TEXT NOT NULL, error_message TEXT, before_snapshot TEXT, after_snapshot TEXT, created_at TEXT NOT NULL)`);
  await db2.knex.raw(`CREATE TABLE asr_hotwords (id TEXT PRIMARY KEY, term TEXT NOT NULL UNIQUE, weight INTEGER NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await db2.knex.raw(`CREATE TABLE meeting_llm_results (
    id TEXT PRIMARY KEY, meeting_asr_result_id TEXT NOT NULL,
    llm_setting_mark TEXT, prompt_template_id TEXT, generation_config_snapshot TEXT,
    generation_mode TEXT, status TEXT, version_no INTEGER, result_type TEXT, result_title TEXT,
    raw_prompt TEXT, raw_response TEXT, result_markdown TEXT, error_message TEXT, created_at TEXT
  )`);
  await db2.knex.raw(`CREATE TABLE meeting_send_records (
    id TEXT PRIMARY KEY, meeting_llm_result_id TEXT NOT NULL, mail_template_type TEXT,
    subject TEXT, to_recipients_json TEXT, cc_recipients_json TEXT, body_markdown TEXT,
    body_html TEXT, status TEXT, mail_setting_mark TEXT, mail_config_snapshot TEXT,
    provider_type TEXT, provider_message_id TEXT, error_message TEXT, sent_by_user_id TEXT,
    created_at TEXT, sent_at TEXT
  )`);
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
    `✅ 场景3 旧库迁移: 数据搬迁 + legacy 清理 + 单行 v${LEGACY_SCHEMA_VERSION} + meeting_audio_recordings 15 列齐全`
  );
  await db2.knex.destroy();

  // --- 场景 6：生产入口（legacy，经 server/db-shared.mjs 的 getDb()）---
  // db-shared.mjs 的 dataDir 在模块加载时取 process.cwd()，所以必须先 chdir 再动态 import。
  const dir3 = mkdtempSync(join(tmpdir(), "db-prod-entry-test-"));
  mkdirSync(join(dir3, "data"), { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(dir3);
  const { getDb: getProdDb } = await import("../server/db-shared.mjs");

  const logs6a = await captureLogs(async () => {
    getProdDb();
  });
  const prodDb = getProdDb();
  assertSingleVersionRow(legacyVersionRows(prodDb), "场景6 生产入口首次");
  assert(
    appliedLogs(logs6a).length === 0,
    `场景6: 全新库不应有 Migration applied，实际 ${JSON.stringify(appliedLogs(logs6a))}`
  );
  const structureBefore6 = legacyStructure(prodDb);

  // 第二次：生产里就是「重启后同一个进程重新初始化」，这里直接再调一次生产入口函数
  const logs6b = await captureLogs(async () => {
    getProdDb();
    initializeDatabase(prodDb);
  });
  assert(
    appliedLogs(logs6b).length === 0,
    `场景6: 第二次初始化不应出现 Migration applied，实际 ${JSON.stringify(appliedLogs(logs6b))}`
  );
  assertSingleVersionRow(legacyVersionRows(prodDb), "场景6 生产入口第二次");
  assert(legacyStructure(prodDb) === structureBefore6, "场景6: 两次初始化之间表结构发生变化");
  console.log(
    `✅ 场景6 生产入口 getDb() 连续两次: 单行 v${LEGACY_SCHEMA_VERSION}、第二次无 Migration applied、结构不变`
  );

  // --- 场景 7：被污染库（legacy，生产同款入口）---
  polluteLegacyVersion(prodDb, [2, 3, 3]);
  const logs7a = await captureLogs(async () => {
    initializeDatabase(prodDb);
  });
  assertSingleVersionRow(legacyVersionRows(prodDb), "场景7 [2,3,3]");
  console.log(
    `✅ 场景7a 生产入口被污染库 [2,3,3] → 单行 v${LEGACY_SCHEMA_VERSION}（日志: ${JSON.stringify(logs7a)}）`
  );

  polluteLegacyVersion(prodDb, [2, 2]);
  const logs7b = await captureLogs(async () => {
    initializeDatabase(prodDb);
  });
  assertSingleVersionRow(legacyVersionRows(prodDb), "场景7 [2,2]");
  assert(
    appliedLogs(logs7b).some((line) => line.includes("v3")),
    `场景7: [2,2] 应重跑 v3（建表幂等），实际 ${JSON.stringify(appliedLogs(logs7b))}`
  );
  console.log("✅ 场景7b 生产入口被污染库 [2,2] → v3 重复执行不报错、收敛单行");
  prodDb.close();

  // --- 场景 8：并发两次初始化（legacy，两个连接）---
  // node:sqlite 是同步 API，同一进程内不会真正交错；这里用两个连接模拟
  // 「node server 与 Next 服务端两个上下文各初始化一次」的调用形态。
  const dir4 = mkdtempSync(join(tmpdir(), "db-prod-concurrent-test-"));
  mkdirSync(join(dir4, "data"), { recursive: true });
  const concurrentPath = join(dir4, "data", "meeting-asr-app.db");
  const connA = new DatabaseSync(concurrentPath);
  const connB = new DatabaseSync(concurrentPath);
  const logs8 = await captureLogs(async () => {
    await Promise.all([
      (async () => initializeDatabase(connA))(),
      (async () => initializeDatabase(connB))(),
    ]);
  });
  assertSingleVersionRow(legacyVersionRows(connA), "场景8 并发");
  assert(
    appliedLogs(logs8).filter((line) => line.includes(`v${LEGACY_SCHEMA_VERSION}`)).length <= 1,
    `场景8: 并发初始化不应重复跑 v${LEGACY_SCHEMA_VERSION}，实际 ${JSON.stringify(appliedLogs(logs8))}`
  );
  connA.close();
  connB.close();
  console.log("✅ 场景8 并发两次生产入口初始化（两个连接）: 单行、无重复迁移");

  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
  rmSync(dir3, { recursive: true, force: true });
  rmSync(dir4, { recursive: true, force: true });
  console.log("🎉 schema 验证全部通过");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
