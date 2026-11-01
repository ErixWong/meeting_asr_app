import { createServer } from "node:http";
import next from "next";
import { attachAsrGateway } from "./asr-gateway.mjs";
import { createTtsGateway } from "./tts-gateway.mjs";
import { cleanupExpiredAuditLogs } from "./db-shared.mjs";
import { cleanupExpiredCaptureSessions, cleanupExpiredAudioRecordings, closeCaptureStore, startCaptureFlushTimer } from "./runtime-store.mjs";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT || 3123);
const hostname = process.env.APP_HOST || "0.0.0.0";
const gatewayPath = process.env.ASR_GATEWAY_PATH || "/asr";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const handleUpgrade = app.getUpgradeHandler();

const ttsGateway = createTtsGateway({ path: process.env.TTS_GATEWAY_PATH || "/api/tts" });

const server = createServer((request, response) => {
  if (ttsGateway.handle(request, response)) return;
  handle(request, response);
});
const gateway = attachAsrGateway(server, {
  path: gatewayPath,
  devMode: dev,
  onUnhandledUpgrade: handleUpgrade,
});


startCaptureFlushTimer();

cleanupExpiredAuditLogs();
const auditCleanupTimer = setInterval(() => {
  try {
    cleanupExpiredAuditLogs();
  } catch (error) {
    console.error("[App Server] audit cleanup failed:", error);
  }
}, 24 * 60 * 60 * 1000);
auditCleanupTimer.unref();

cleanupExpiredCaptureSessions();
const captureCleanupTimer = setInterval(() => {
  try {
    cleanupExpiredCaptureSessions();
  } catch (error) {
    console.error("[App Server] capture cleanup failed:", error);
  }
}, 60 * 60 * 1000);
captureCleanupTimer.unref();

// 孤儿录音清理（feat-261101-01）：未绑定会议且过期 → 删行 + 删文件。
// 已绑定会议的录音 expires_at 为 NULL，永不被清。
cleanupExpiredAudioRecordings();
const audioCleanupTimer = setInterval(() => {
  try {
    const result = cleanupExpiredAudioRecordings();
    if (result.rows > 0) {
      console.log(`[App Server] audio cleanup: removed ${result.rows} row(s), ${result.files} file(s)`);
    }
  } catch (error) {
    console.error("[App Server] audio cleanup failed:", error);
  }
}, 60 * 60 * 1000);
audioCleanupTimer.unref();

server.listen(port, hostname, () => {
  console.log(`[App Server] ${dev ? "Development" : "Production"} server running on http://${hostname}:${port}`);
  console.log(`[ASR Gateway] WebSocket endpoint: ws://localhost:${port}${gatewayPath}`);
});

function shutdown(signal) {
  console.log(`[App Server] Received ${signal}, shutting down`);
  clearInterval(auditCleanupTimer);
  clearInterval(captureCleanupTimer);
  clearInterval(audioCleanupTimer);
  closeCaptureStore();
  gateway.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
