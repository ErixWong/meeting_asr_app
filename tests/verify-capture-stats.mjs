// round07 验收：capture 会话统计（stats）与 raw_payload 结构化
// 单元级：直接驱动 runtime-store 验证统计累计；服务级：创建会议验证 payload 结构。
// 在临时目录运行，不污染项目 data/。
// 用法：node tests/verify-capture-stats.mjs

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmpDir = mkdtempSync(join(tmpdir(), "asr-capture-stats-"));
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

function newSession(tag) {
  const sessionId = `stats-${tag}-${crypto.randomUUID()}`;
  store.createCaptureSession({
    captureSessionId: sessionId,
    taskId: `task-${tag}`,
    asrProvider: "local_funasr",
    asrConfigSnapshot: { providerType: "local_funasr" },
    hotwords: {},
  });
  return sessionId;
}

// 1. 统计累计：online/offline/final/spk/首末时间
const sessionId = newSession("basic");
store.appendCaptureEvent(sessionId, { payload: { mode: "2pass-online", result: { text: "你", is_final: false } } });
store.appendCaptureEvent(sessionId, { payload: { mode: "2pass-online", result: { text: "你好", is_final: false } } });
store.appendCaptureEvent(sessionId, {
  payload: {
    mode: "2pass-offline",
    result: {
      text: "你好世界",
      is_final: true,
      segments: [
        { spk: 0, text: "你好" },
        { spk: 1, text: "世界" },
      ],
    },
  },
});
store.appendCaptureEvent(sessionId, { payload: { mode: "2pass-offline", result: { text: "修正", is_final: false } } });

let stats = store.getCaptureSessionStats(sessionId);
check(stats?.totalEvents === 4, `totalEvents=4（实际 ${stats?.totalEvents}）`);
check(stats?.onlineEvents === 2, `onlineEvents=2（实际 ${stats?.onlineEvents}）`);
check(stats?.offlineEvents === 2, `offlineEvents=2（实际 ${stats?.offlineEvents}）`);
check(stats?.finalSegmentsCount === 2, `finalSegmentsCount=2（实际 ${stats?.finalSegmentsCount}）`);
check(JSON.stringify(stats?.speakerIds) === "[0,1]", `speakerIds=[0,1]（实际 ${JSON.stringify(stats?.speakerIds)}）`);
check(Boolean(stats?.firstEventAt) && Boolean(stats?.lastEventAt), "首末时间已记录");
check(stats?.lastEventAt >= stats?.firstEventAt, "末时间 >= 首时间");

// 2. 拒绝事件不统计（未知会话）
check(store.appendCaptureEvent("no-such-session", { payload: { mode: "2pass-online" } }) === false, "未知会话拒绝");
check(store.getCaptureSessionStats("no-such-session") === null, "未知会话 stats 为 null");

// 3. releaseCaptureSession 清理
store.releaseCaptureSession(sessionId);
check(store.getCaptureSessionStats(sessionId) === null, "release 后 stats 已清理");

// 4. 超限拒绝后 stats 保持（10000 上限）
const limitSession = newSession("limit");
let accepted = 0;
for (let i = 0; i < 10002; i++) {
  if (store.appendCaptureEvent(limitSession, { payload: { mode: "2pass-online" } })) accepted++;
  else break;
}
stats = store.getCaptureSessionStats(limitSession);
check(accepted === 10000 && stats?.totalEvents === 10000, `超限拒绝不统计（total=${stats?.totalEvents}）`);

// 5. 会话过期后 append 拒绝并释放条目
const expiredSession = newSession("expired");
verifyDb
  .prepare("UPDATE asr_capture_sessions SET expires_at = ? WHERE capture_session_id = ?")
  .run(new Date(Date.now() - 1000).toISOString(), expiredSession);
check(store.appendCaptureEvent(expiredSession, { payload: { mode: "2pass-online" } }) === false, "过期会话拒绝");
check(store.getCaptureSessionStats(expiredSession) === null, "过期会话 stats 已释放");

verifyDb.close();
if (failures > 0) process.exit(1);
console.log("CAPTURE STATS VERIFY PASSED");
