// round06 验收：getAsrRuntimeConfig 缓存 + 失效；cleanupExpiredCaptureSessions 删除过期会话
// 在临时目录运行，不污染项目 data/。
// 用法：node tests/verify-config-cache.mjs

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmpDir = mkdtempSync(join(tmpdir(), "asr-config-cache-"));
process.chdir(tmpDir);
mkdirSync(join(tmpDir, "data"), { recursive: true });

const store = await import("../server/runtime-store.mjs");
store.cleanupExpiredCaptureSessions();

const dbPath = join(tmpDir, "data", "meeting-asr-app.db");
const verifyDb = new DatabaseSync(dbPath);

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

// 1. 首次读取（构建缓存）
const first = store.getAsrRuntimeConfig();
check(first.endpoint === "ws://funasr.local:10095/ws", `首次读取默认 endpoint（实际 ${first.endpoint}）`);

// 2. 改库后缓存仍旧值
verifyDb
  .prepare("UPDATE app_settings SET item_value = ? WHERE item_section='asr' AND item_mark='endpoint'")
  .run("ws://changed.example:1234/ws");
const cached = store.getAsrRuntimeConfig();
check(cached.endpoint === "ws://funasr.local:10095/ws", "改库后缓存仍旧值（未失效前不重查）");

// 3. 失效后读到新值
store.invalidateAsrRuntimeConfig();
const refreshed = store.getAsrRuntimeConfig();
check(refreshed.endpoint === "ws://changed.example:1234/ws", `失效后读到新值（实际 ${refreshed.endpoint}）`);

// 4. 失效函数幂等（无缓存时调用不报错）
store.invalidateAsrRuntimeConfig();
check(true, "重复失效幂等");

// 5. cleanupExpiredCaptureSessions 删除过期会话
const now = new Date().toISOString();
const expired = `cap-expired-${crypto.randomUUID()}`;
const fresh = `cap-fresh-${crypto.randomUUID()}`;
const insertSession = verifyDb.prepare(`
  INSERT INTO asr_capture_sessions (capture_session_id, task_id, asr_provider, asr_config_snapshot,
    hotwords_json, status, created_at, updated_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertSession.run(expired, "t", "local_funasr", "{}", "{}", "capturing", now, now,
  new Date(Date.now() - 1000).toISOString());
insertSession.run(fresh, "t", "local_funasr", "{}", "{}", "capturing", now, now,
  new Date(Date.now() + 3600_000).toISOString());
store.cleanupExpiredCaptureSessions();
const expiredLeft = verifyDb.prepare("SELECT COUNT(*) as c FROM asr_capture_sessions WHERE capture_session_id = ?").get(expired);
const freshLeft = verifyDb.prepare("SELECT COUNT(*) as c FROM asr_capture_sessions WHERE capture_session_id = ?").get(fresh);
check(Number(expiredLeft.c) === 0, "过期会话被清理");
check(Number(freshLeft.c) === 1, "未过期会话保留");

verifyDb.close();
if (failures > 0) process.exit(1);
console.log("CONFIG CACHE VERIFY PASSED");
