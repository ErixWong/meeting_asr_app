// 数据完整性验收：外键生效、孤儿行检查、CASCADE/RESTRICT 行为（refactor-260804-02 round02）
// 在临时目录运行，不污染项目 data/。
// 用法：node tests/verify-integrity.mjs

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmpDir = mkdtempSync(join(tmpdir(), "asr-integrity-"));
process.chdir(tmpDir);
mkdirSync(join(tmpDir, "data"), { recursive: true });

const store = await import("../server/runtime-store.mjs");
store.cleanupExpiredCaptureSessions();

const dbPath = join(tmpDir, "data", "meeting-asr-app.db");
const db = new DatabaseSync(dbPath);

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

// 1. FK 已开启（连接级）
check(Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys) === 1, "PRAGMA foreign_keys = ON");

// 2. 新索引存在
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
check(indexes.includes("idx_meetings_owner_created"), "idx_meetings_owner_created 存在");
check(indexes.includes("idx_auth_sessions_user"), "idx_auth_sessions_user 存在");

// 3. 孤儿行检查（空库无孤儿，构造孤儿插入应被 FK 拒绝）
let fkRejected = false;
try {
  db.prepare("INSERT INTO meeting_asr_results (id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot, capture_session_id, result_format, raw_payload, normalized_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("orphan-1", "no-such-meeting", "p", "m", "{}", "cap", "f", "{}", "", new Date().toISOString());
} catch (err) {
  fkRejected = /FOREIGN KEY/i.test(String(err?.message ?? ""));
}
check(fkRejected, "孤儿 meeting_asr_results 插入被 FK 拒绝");

// 4. 构造基础数据
const now = new Date().toISOString();
db.prepare("INSERT OR IGNORE INTO roles (id, role_key, role_name, created_at) VALUES ('role-user', 'user', 'User', ?)").run(now);
db.prepare("INSERT OR IGNORE INTO llm_prompt_templates (id, template_key, template_name, template_type, content, status, is_system, created_at, updated_at) VALUES ('tpl-1', 'summary-default', '默认纪要', 'summary', '模板', 'active', 1, ?, ?)")
  .run(now, now);
db.prepare("INSERT INTO users (id, account_name, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
  .run("user-1", "user1", "用户一", now, now);
db.prepare("INSERT INTO users (id, account_name, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
  .run("user-2", "user2", "用户二", now, now);
const roleId = db.prepare("SELECT id FROM roles WHERE role_key = 'user'").get().id;
db.prepare("INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)")
  .run("ur-1", "user-1", roleId, now);
db.prepare("INSERT INTO meetings (id, title, source_type, status, status_updated_at, created_by_user_id, created_by_user_name, created_at, updated_at) VALUES (?, ?, ?, 'transcribed', ?, ?, ?, ?, ?)")
  .run("meeting-1", "测试会议", "upload", now, "user-1", "用户一", now, now);
db.prepare("INSERT INTO meeting_asr_results (id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot, capture_session_id, result_format, raw_payload, normalized_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run("asr-1", "meeting-1", "local_funasr", "m", "{}", "cap-1", "f", "{}", "文本", now);
const templateId = db.prepare("SELECT id FROM llm_prompt_templates LIMIT 1").get().id;
db.prepare("INSERT INTO meeting_llm_results (id, meeting_id, input_transcript_snapshot, llm_setting_mark, prompt_template_id, generation_config_snapshot, generation_mode, status, version_no, result_type, result_title, raw_prompt, raw_response, result_markdown, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', 1, 'summary', '标题', '', '', '正文', ?)")
  .run("llm-1", "meeting-1", "文本", "m", templateId, "{}", "manual", now);
db.prepare("INSERT INTO meeting_send_records (id, meeting_llm_result_id, mail_template_type, subject, to_recipients_json, cc_recipients_json, body_markdown, body_html, status, mail_setting_mark, mail_config_snapshot, provider_type, sent_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', 'm', '{}', 'smtp', ?, ?)")
  .run("send-1", "llm-1", "meeting", "主题", "[]", "[]", "正文", "<p>正文</p>", "user-1", now);
db.prepare("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("sess-1", "user-2", "token-hash-1", new Date(Date.now() + 3600_000).toISOString(), now, now);

// 5. CASCADE：删除会议 → asr/llm/send 级联删除
db.prepare("DELETE FROM meetings WHERE id = ?").run("meeting-1");
const orphans = {
  asr: db.prepare("SELECT COUNT(*) as c FROM meeting_asr_results WHERE id = 'asr-1'").get().c,
  llm: db.prepare("SELECT COUNT(*) as c FROM meeting_llm_results WHERE id = 'llm-1'").get().c,
  send: db.prepare("SELECT COUNT(*) as c FROM meeting_send_records WHERE id = 'send-1'").get().c,
};
check(Number(orphans.asr) === 0 && Number(orphans.llm) === 0 && Number(orphans.send) === 0, "删除会议级联清理 asr/llm/send 子表");

// 6. CASCADE：删除 llm_result → send_records 级联（重建会议 + llm + send 再删 llm）
db.prepare("INSERT INTO meetings (id, title, source_type, status, status_updated_at, created_by_user_id, created_by_user_name, created_at, updated_at) VALUES (?, ?, ?, 'transcribed', ?, ?, ?, ?, ?)")
  .run("meeting-1", "测试会议", "upload", now, "user-1", "用户一", now, now);
db.prepare("INSERT INTO meeting_asr_results (id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot, capture_session_id, result_format, raw_payload, normalized_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run("asr-2", "meeting-1", "p", "m", "{}", "cap-2", "f", "{}", "", now);
db.prepare("INSERT INTO meeting_llm_results (id, meeting_id, input_transcript_snapshot, llm_setting_mark, prompt_template_id, generation_config_snapshot, generation_mode, status, version_no, result_type, result_title, raw_prompt, raw_response, result_markdown, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', 1, 'summary', '标题', '', '', '正文', ?)")
  .run("llm-2", "meeting-1", "", "m", templateId, "{}", "manual", now);
db.prepare("INSERT INTO meeting_send_records (id, meeting_llm_result_id, mail_template_type, subject, to_recipients_json, cc_recipients_json, body_markdown, body_html, status, mail_setting_mark, mail_config_snapshot, provider_type, sent_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', 'm', '{}', 'smtp', ?, ?)")
  .run("send-2", "llm-2", "meeting", "主题", "[]", "[]", "正文", "<p>正文</p>", "user-1", now);
db.prepare("DELETE FROM meeting_llm_results WHERE id = ?").run("llm-2");
check(Number(db.prepare("SELECT COUNT(*) as c FROM meeting_send_records WHERE id = 'send-2'").get().c) === 0, "删除 llm_result 级联清理 send_records");

// 7. RESTRICT：删除仍有会议的 user 被拒
let restrictRejected = false;
try {
  db.prepare("DELETE FROM users WHERE id = 'user-1'").run();
} catch (err) {
  restrictRejected = /FOREIGN KEY/i.test(String(err?.message ?? ""));
}
check(restrictRejected, "删除仍有会议的 user 被 FK RESTRICT 拒绝");

// 8. user_roles CASCADE：删除 user → user_roles 级联
db.prepare("DELETE FROM users WHERE id = ?").run("user-2");
check(Number(db.prepare("SELECT COUNT(*) as c FROM user_roles WHERE user_id = 'user-2'").get().c) === 0, "删除 user 级联清理 user_roles");
check(Number(db.prepare("SELECT COUNT(*) as c FROM auth_sessions WHERE user_id = 'user-2'").get().c) === 0, "删除 user 级联清理 auth_sessions");

// 9. 查询计划走索引（listMeetings 模式）
const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM meetings WHERE created_by_user_id = ? ORDER BY created_at DESC").all("user-1");
const planText = JSON.stringify(plan);
check(/idx_meetings_owner_created/.test(planText), "listMeetings 查询计划使用 idx_meetings_owner_created");

db.close();
if (failures > 0) process.exit(1);
console.log("INTEGRITY VERIFY PASSED");
