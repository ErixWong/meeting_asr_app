// 验收：ASR 捕获事件批量落库（fix-260805-03 round01）
// 在临时目录运行，不污染项目 data/。
// 用法：node tests/verify-capture-batching.mjs

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmpDir = mkdtempSync(join(tmpdir(), "asr-capture-batching-"));
process.chdir(tmpDir);
mkdirSync(join(tmpDir, "data"), { recursive: true });

const store = await import("../server/runtime-store.mjs");
store.cleanupExpiredCaptureSessions();

const dbPath = join(tmpDir, "data", "meeting-asr-app.db");
const verifyDb = new DatabaseSync(dbPath);

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

function countEvents(sessionId) {
  const row = verifyDb
    .prepare("SELECT COUNT(*) as count FROM asr_capture_events WHERE capture_session_id = ?")
    .get(sessionId);
  return Number(row?.count ?? 0);
}

function listSequences(sessionId) {
  return verifyDb
    .prepare(
      "SELECT sequence_no FROM asr_capture_events WHERE capture_session_id = ? ORDER BY sequence_no ASC"
    )
    .all(sessionId)
    .map((row) => Number(row.sequence_no));
}

function newSession(tag) {
  const sessionId = `verify-${tag}-${crypto.randomUUID()}`;
  store.createCaptureSession({
    captureSessionId: sessionId,
    taskId: `task-${tag}`,
    asrProvider: "local_funasr",
    asrConfigSnapshot: { providerType: "local_funasr" },
    hotwords: {},
  });
  return sessionId;
}

const smallEvent = () => ({ mode: "2pass-online", text: "测试文本", is_final: false });

console.log("[1] WAL 生效");
{
  const row = verifyDb.prepare("PRAGMA journal_mode").get();
  check(String(row?.journal_mode ?? "").toLowerCase() === "wal", `journal_mode=wal (actual=${row?.journal_mode})`);
}

console.log("[2] 入队不落盘，flush 后落盘且 sequence 连续");
{
  const sessionId = newSession("basic");
  for (let i = 0; i < 10; i++) check(store.appendCaptureEvent(sessionId, smallEvent()), `append #${i + 1}`);
  check(countEvents(sessionId) === 0, "入队 10 条后 DB 行数为 0（纯内存）");

  const flushed = store.flushCaptureEvents();
  check(flushed === 10, `flush 返回 10（实际 ${flushed}）`);
  check(countEvents(sessionId) === 10, "flush 后 DB 行数为 10");
  const seq = listSequences(sessionId);
  check(seq.length === 10 && seq.every((v, i) => v === i + 1), `sequence_no 1..10 连续（实际 ${seq.join(",")}）`);
}

console.log("[3] drain 指定会话立即落盘");
{
  const sessionId = newSession("drain");
  store.appendCaptureEvent(sessionId, smallEvent());
  store.appendCaptureEvent(sessionId, smallEvent());
  store.appendCaptureEvent(sessionId, smallEvent());
  check(countEvents(sessionId) === 0, "3 条入队未落盘");
  const drained = store.drainCaptureEvents(sessionId);
  check(drained === 3, `drain 返回 3（实际 ${drained}）`);
  check(countEvents(sessionId) === 3, "drain 后 DB 行数为 3");
  check(store.drainCaptureEvents(sessionId) === 0, "空队列 drain 幂等返回 0");
}

console.log("[4] 多会话隔离");
{
  const a = newSession("iso-a");
  const b = newSession("iso-b");
  store.appendCaptureEvent(a, smallEvent());
  store.appendCaptureEvent(b, smallEvent());
  store.appendCaptureEvent(b, smallEvent());
  store.flushCaptureEvents();
  check(listSequences(a).join(",") === "1", `会话 A sequence=1（实际 ${listSequences(a).join(",")}）`);
  check(listSequences(b).join(",") === "1,2", `会话 B sequence=1,2（实际 ${listSequences(b).join(",")}）`);
}

console.log("[5] 限额：单条超 512KB 拒绝");
{
  const sessionId = newSession("oversize");
  const big = { text: "x".repeat(512 * 1024) };
  check(store.appendCaptureEvent(sessionId, big) === false, "单条 >512KB 返回 false");
  check(countEvents(sessionId) === 0, "无事件落盘");
}

console.log("[6] 限额：事件数达 10000 上限后拒绝");
{
  const sessionId = newSession("count-limit");
  let accepted = 0;
  for (let i = 0; i < 10002; i++) {
    if (store.appendCaptureEvent(sessionId, smallEvent())) accepted++;
    else break;
  }
  check(accepted === 10000, `接受 10000 条后拒绝（实际接受 ${accepted}）`);
  const flushed = store.flushCaptureEvents(sessionId);
  check(flushed === 10000, `flush 10000 条（实际 ${flushed}）`);
  check(countEvents(sessionId) === 10000, "DB 行数为 10000");
}

console.log("[7] 不存在的会话拒绝");
{
  check(store.appendCaptureEvent("no-such-session", smallEvent()) === false, "未知会话返回 false");
}

console.log("[8] 过期会话拒绝");
{
  const sessionId = newSession("expired");
  verifyDb
    .prepare("UPDATE asr_capture_sessions SET expires_at = ? WHERE capture_session_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), sessionId);
  check(store.appendCaptureEvent(sessionId, smallEvent()) === false, "过期会话返回 false");
}

console.log("[9] finish 后 drain 可读完整事件");
{
  const sessionId = newSession("finish");
  for (let i = 0; i < 5; i++) store.appendCaptureEvent(sessionId, smallEvent());
  store.finishCaptureSession(sessionId);
  store.drainCaptureEvents(sessionId);
  check(countEvents(sessionId) === 5, "finish+drain 后 5 条完整");
}

verifyDb.close();

if (failures > 0) {
  console.error(`\nVERIFY FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nVERIFY PASSED: capture batching works as designed");
