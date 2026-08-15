/**
 * schema 初始化/迁移验证（PR-B 临时测试，sqlite）
 *
 * 场景：
 *   1. 全新库初始化 → 14 张表 + schema_version=2
 *   2. 幂等：重复初始化不报错、版本不变
 *   3. 旧库迁移：构造 v0 旧结构（legacy 含 meeting_asr_result_id）→ 数据搬迁到新结构
 */
import { createKnexInstance } from "../server/db/index.mjs";
import { AsyncDb, listTableColumns } from "../server/db/async-db.mjs";
import { initializeSchema } from "../server/db/schema.mjs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

async function main() {
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
    "schema_version", "user_roles", "users",
  ].sort();
  assert(JSON.stringify(tableNames) === JSON.stringify(expected), `表清单不符: ${tableNames}`);
  const ver = await db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  assert(Number(ver.version) === 2, `版本号应为 2, 实际 ${ver.version}`);
  console.log("✅ 场景1 全新库初始化: 15 张表 + schema_version=2");

  // --- 场景 2：幂等 ---
  await initializeSchema(db);
  const ver2 = await db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  assert(Number(ver2.version) === 2, `重复初始化后版本变化: ${ver2.version}`);
  console.log("✅ 场景2 幂等: 重复初始化无副作用");

  await db.knex.destroy();

  // --- 场景 3：旧库迁移 ---
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
  const ver3 = await db2.prepare("SELECT version FROM schema_version LIMIT 1").get();
  assert(Number(ver3.version) === 2, `迁移后版本应为 2`);
  console.log("✅ 场景3 旧库迁移: 数据搬迁 + legacy 清理 + 版本=2");

  await db2.knex.destroy();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
  console.log("🎉 schema 验证全部通过");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
