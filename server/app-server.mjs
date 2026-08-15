import { createServer } from "node:http";
import next from "next";
import { attachAsrGateway } from "./asr-gateway.mjs";
import { createTtsGateway } from "./tts-gateway.mjs";
import { cleanupExpiredAuditLogs } from "./db-shared.mjs";
import { cleanupExpiredCaptureSessions, closeCaptureStore, startCaptureFlushTimer } from "./runtime-store.mjs";

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

server.listen(port, hostname, () => {
  console.log(`[App Server] ${dev ? "Development" : "Production"} server running on http://${hostname}:${port}`);
  console.log(`[ASR Gateway] WebSocket endpoint: ws://localhost:${port}${gatewayPath}`);
});

function shutdown(signal) {
  console.log(`[App Server] Received ${signal}, shutting down`);
  clearInterval(auditCleanupTimer);
  clearInterval(captureCleanupTimer);
  closeCaptureStore();
  gateway.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
