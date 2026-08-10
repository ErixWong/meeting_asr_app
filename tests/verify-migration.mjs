// 旧库升级验收：版本化迁移机制（feat-260810-03-db-migration）
// 在临时目录运行，不污染项目 data/。
// 覆盖：旧结构库（meeting_asr_result_id 外键 + 重复版本数据）自动升级、
//       去重保留最新、幂等（二次初始化不重复迁移）、全新库直接最新结构。
// 用法：node tests/verify-migration.mjs

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmpDir = mkdtempSync(join(tmpdir(), "asr-migration-"));
process.chdir(tmpDir);
mkdirSync(join(tmpDir, "data"), { recursive: true });

const { initializeDatabase } = await import("../server/database-schema.mjs");

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

/**
 * 构造旧结构库：meeting_llm_results 使用旧外键 meeting_asr_result_id（无 meeting_id），
 * meeting_send_records 用旧关联；meetings/meeting_asr_results 结构与新版一致（真实旧库如此）。
 * 数据刻意包含：
 *  - 同一会议同一 version_no 的 3 条重复 llm_result（旧 schema 允许，新 schema UNIQUE 会冲突）
 *  - 一条关联不到 asr 的孤儿 llm_result（迁移时 JOIN 丢弃）
 */
function createLegacyDb(db) {
  const now = new Date().toISOString();

  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_file_name TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL,
      status_updated_at TEXT NOT NULL,
      last_error_message TEXT,
      created_by_user_id TEXT NOT NULL,
      created_by_user_name TEXT NOT NULL,
      created_by_user_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE meeting_asr_results (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL,
      asr_provider TEXT NOT NULL,
      asr_setting_mark TEXT NOT NULL,
      asr_config_snapshot TEXT NOT NULL,
      capture_session_id TEXT NOT NULL,
      result_format TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE meeting_llm_results (
      id TEXT PRIMARY KEY,
      meeting_asr_result_id TEXT NOT NULL,
      llm_setting_mark TEXT NOT NULL,
      prompt_template_id TEXT NOT NULL,
      generation_config_snapshot TEXT NOT NULL,
      generation_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      result_type TEXT NOT NULL,
      result_title TEXT NOT NULL,
      raw_prompt TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      result_markdown TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE meeting_send_records (
      id TEXT PRIMARY KEY,
      meeting_llm_result_id TEXT NOT NULL,
      mail_template_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      to_recipients_json TEXT NOT NULL,
      cc_recipients_json TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      body_html TEXT NOT NULL,
      status TEXT NOT NULL,
      mail_setting_mark TEXT NOT NULL,
      mail_config_snapshot TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_message_id TEXT,
      error_message TEXT,
      sent_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
  `);

  // 基础数据：2 个会议、2 个 asr 结果
  db.prepare("INSERT INTO meetings (id, title, source_type, status, status_updated_at, created_by_user_id, created_by_user_name, created_at, updated_at) VALUES (?, ?, ?, 'transcribed', ?, 'u1', '用户一', ?, ?)")
    .run("meeting-a", "会议A", "upload", now, now, now);
  db.prepare("INSERT INTO meetings (id, title, source_type, status, status_updated_at, created_by_user_id, created_by_user_name, created_at, updated_at) VALUES (?, ?, ?, 'transcribed', ?, 'u1', '用户一', ?, ?)")
    .run("meeting-b", "会议B", "upload", now, now, now);
  db.prepare("INSERT INTO meeting_asr_results (id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot, capture_session_id, result_format, raw_payload, normalized_text, created_at) VALUES (?, ?, 'p', 'm', '{}', 'cap-1', 'f', '{}', '文本A', ?)")
    .run("asr-a", "meeting-a", now);
  db.prepare("INSERT INTO meeting_asr_results (id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot, capture_session_id, result_format, raw_payload, normalized_text, created_at) VALUES (?, ?, 'p', 'm', '{}', 'cap-2', 'f', '{}', '文本B', ?)")
    .run("asr-b", "meeting-b", now);

  const insertLlm = db.prepare(`
    INSERT INTO meeting_llm_results (
      id, meeting_asr_result_id, llm_setting_mark, prompt_template_id,
      generation_config_snapshot, generation_mode, status, version_no,
      result_type, result_title, raw_prompt, raw_response, result_markdown,
      error_message, created_at
    ) VALUES (?, ?, 'm', 'tpl-1', '{}', 'manual', 'succeeded', ?, 'summary', ?, '', '', ?, NULL, ?)
  `);
  // 会议A v1：3 条重复（created_at 依次更晚，最新 id=llm-a3）
  insertLlm.run("llm-a1", "asr-a", 1, "早版本", "内容-1", "2026-07-01T00:00:00.000Z");
  insertLlm.run("llm-a2", "asr-a", 1, "中版本", "内容-2", "2026-07-02T00:00:00.000Z");
  insertLlm.run("llm-a3", "asr-a", 1, "晚版本", "内容-3", "2026-07-03T00:00:00.000Z");
  // 会议A v2：唯一
  insertLlm.run("llm-a4", "asr-a", 2, "V2", "内容-4", "2026-07-04T00:00:00.000Z");
  // 会议B v1：唯一
  insertLlm.run("llm-b1", "asr-b", 1, "B版本", "内容-5", "2026-07-05T00:00:00.000Z");
  // 孤儿：关联不存在的 asr（迁移应丢弃）
  insertLlm.run("llm-orphan", "asr-no-such", 1, "孤儿", "内容-6", "2026-07-06T00:00:00.000Z");

  // send_records：一条挂 llm-a1（将被去重丢弃的版本），一条挂 llm-a3（保留的版本）
  db.prepare("INSERT INTO meeting_send_records (id, meeting_llm_result_id, mail_template_type, subject, to_recipients_json, cc_recipients_json, body_markdown, body_html, status, mail_setting_mark, mail_config_snapshot, provider_type, sent_by_user_id, created_at) VALUES (?, ?, 'meeting', '主题A1', '[]', '[]', '正文', '<p>正文</p>', 'success', 'm', '{}', 'smtp', 'u1', ?)")
    .run("send-a1", "llm-a1", now);
  db.prepare("INSERT INTO meeting_send_records (id, meeting_llm_result_id, mail_template_type, subject, to_recipients_json, cc_recipients_json, body_markdown, body_html, status, mail_setting_mark, mail_config_snapshot, provider_type, sent_by_user_id, created_at) VALUES (?, ?, 'meeting', '主题A3', '[]', '[]', '正文', '<p>正文</p>', 'success', 'm', '{}', 'smtp', 'u1', ?)")
    .run("send-a3", "llm-a3", now);
}

// ============ 场景 1：旧结构库升级 ============
const dbPath = join(tmpDir, "data", "meeting-asr-app.db");
const db = new DatabaseSync(dbPath);
createLegacyDb(db);

// 升级前：确认旧结构（无 schema_version、旧外键）
check(
  !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get(),
  "升级前：无 schema_version 表"
);
const legacyCols = db.prepare("PRAGMA table_info(meeting_llm_results)").all();
check(
  !legacyCols.some((c) => c.name === "meeting_id") && legacyCols.some((c) => c.name === "meeting_asr_result_id"),
  "升级前：meeting_llm_results 为旧结构（meeting_asr_result_id，无 meeting_id）"
);

initializeDatabase(db);

// 升级后：版本号
const version = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
check(Number(version?.version) === 1, "升级后：schema_version = 1");

// 升级后：新结构
const newCols = db.prepare("PRAGMA table_info(meeting_llm_results)").all();
check(
  newCols.some((c) => c.name === "meeting_id") && !newCols.some((c) => c.name === "meeting_asr_result_id"),
  "升级后：meeting_llm_results 为新结构（meeting_id，无 meeting_asr_result_id）"
);

// 升级后：行数与去重（6 条旧数据 → 会议A v1 去重保留 1 + 会议A v2 1 + 会议B v1 1 = 3 条，孤儿丢弃）
const llmRows = db.prepare("SELECT COUNT(*) AS c FROM meeting_llm_results").get();
check(Number(llmRows.c) === 3, `升级后：llm_results 行数 = 3（去重+丢弃孤儿，实际 ${llmRows.c}）`);

// 去重保留最新（llm-a3）
const keptA1 = db.prepare("SELECT id FROM meeting_llm_results WHERE meeting_id = 'meeting-a' AND version_no = 1").all();
check(
  keptA1.length === 1 && keptA1[0].id === "llm-a3",
  `升级后：会议A v1 保留最新 llm-a3（实际 ${keptA1.map((r) => r.id).join(",") || "空"}）`
);

// 孤儿被丢弃
const orphan = db.prepare("SELECT COUNT(*) AS c FROM meeting_llm_results WHERE id = 'llm-orphan'").get();
check(Number(orphan.c) === 0, "升级后：孤儿 llm-orphan 被丢弃");

// 孤行检查（meeting_id 全部有效）
const orphanRows = db.prepare("SELECT COUNT(*) AS c FROM meeting_llm_results WHERE meeting_id IS NULL OR meeting_id = ''").get();
check(Number(orphanRows.c) === 0, "升级后：无 meeting_id 孤行");

// send_records：仅保留 llm-a3 关联的一条（llm-a1 的去重版本被丢弃）
const sendRows = db.prepare("SELECT meeting_llm_result_id FROM meeting_send_records").all();
check(
  sendRows.length === 1 && sendRows[0].meeting_llm_result_id === "llm-a3",
  `升级后：send_records 仅保留 llm-a3 关联（实际 ${sendRows.map((r) => r.meeting_llm_result_id).join(",") || "空"}）`
);

// 无 legacy 残留
const legacyTables = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%legacy%'").all();
check(legacyTables.length === 0, "升级后：无 legacy 表残留");

// ============ 场景 2：幂等（二次初始化不重复迁移） ============
initializeDatabase(db);
const version2 = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
check(Number(version2?.version) === 1, "幂等：二次初始化后 version 仍 = 1");
const llmRows2 = db.prepare("SELECT COUNT(*) AS c FROM meeting_llm_results").get();
check(Number(llmRows2.c) === 3, "幂等：二次初始化后行数不变（仍 3）");

db.close();

// ============ 场景 3：全新库直接最新结构 ============
const freshDbPath = join(tmpDir, "data", "fresh.db");
const freshDb = new DatabaseSync(freshDbPath);
initializeDatabase(freshDb);
const freshVersion = freshDb.prepare("SELECT version FROM schema_version LIMIT 1").get();
check(Number(freshVersion?.version) === 1, "全新库：schema_version = 1");
const freshCols = freshDb.prepare("PRAGMA table_info(meeting_llm_results)").all();
check(freshCols.some((c) => c.name === "meeting_id"), "全新库：meeting_llm_results 直接新结构");
const freshIdx = freshDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_meeting_llm_results_meeting_version_created'").get();
check(Boolean(freshIdx), "全新库：idx_meeting_llm_results_meeting_version_created 存在");
freshDb.close();

if (failures > 0) process.exit(1);
console.log("MIGRATION VERIFY PASSED");
