import { createServer } from "node:http";
import next from "next";
import { attachAsrGateway } from "./asr-gateway.mjs";
import { createTtsGateway } from "./tts-gateway.mjs";
import { cleanupExpiredAuditLogs } from "./db-shared.mjs";
import {
  cleanupExpiredCaptureSessions,
  closeCaptureStore,
  getAsrRuntimeConfig,
  getAudioRuntimeConfig,
  runAudioMaintenance,
  startCaptureFlushTimer,
} from "./runtime-store.mjs";

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

// 启动期先把 ASR/录音配置读进缓存（#54 async 传导）：WS 连接建立后取配置是同步语义
// 的热路径，提前预热可避免「首条消息早于配置读取完成」的窗口。
await getAsrRuntimeConfig();
await getAudioRuntimeConfig();

void cleanupExpiredAuditLogs().catch((error) => {
  console.error("[App Server] audit cleanup failed:", error);
});
const auditCleanupTimer = setInterval(() => {
  void cleanupExpiredAuditLogs().catch((error) => {
    console.error("[App Server] audit cleanup failed:", error);
  });
}, 24 * 60 * 60 * 1000);
auditCleanupTimer.unref();

void cleanupExpiredCaptureSessions().catch((error) => {
  console.error("[App Server] capture cleanup failed:", error);
});
const captureCleanupTimer = setInterval(() => {
  void cleanupExpiredCaptureSessions().catch((error) => {
    console.error("[App Server] capture cleanup failed:", error);
  });
}, 60 * 60 * 1000);
captureCleanupTimer.unref();

// 录音维护（feat-261101-01 孤儿清理 + feat-261103-01 到期清理与磁盘水位）：
// 启动跑一次，之后每小时一次（复用同一个定时器，不新起进程、不用系统 cron）。
//   - 磁盘水位：data/audio 所在 fs 可用空间 < audio.disk_warn_gb → console.warn
//   - 孤儿：meeting_id IS NULL 且 expires_at 过期 → 删行 + 删文件（语义未变）
//   - 到期：meeting_id 非空 + status='ready' + updated_at < now - bound_retention_days
//           → 只删 MP3，置 status='purged' / purged_at（转写与会议不动）
function reportAudioMaintenance(result) {
  if (result.orphan.rows > 0) {
    console.log(`[App Server] audio cleanup: removed ${result.orphan.rows} row(s), ${result.orphan.files} file(s)`);
  }
  if (result.retention.purged > 0 || result.retention.failed > 0) {
    console.log(
      `[App Server] audio retention: purged ${result.retention.purged} file(s), ` +
        `failed ${result.retention.failed}, freed ${result.retention.bytes} bytes`
    );
  }
}

void runAudioMaintenance()
  .then(reportAudioMaintenance)
  .catch((error) => {
    console.error("[App Server] audio cleanup failed:", error);
  });
const audioCleanupTimer = setInterval(() => {
  void runAudioMaintenance()
    .then(reportAudioMaintenance)
    .catch((error) => {
      console.error("[App Server] audio cleanup failed:", error);
    });
}, 60 * 60 * 1000);
audioCleanupTimer.unref();

server.listen(port, hostname, () => {
  console.log(`[App Server] ${dev ? "Development" : "Production"} server running on http://${hostname}:${port}`);
  console.log(`[ASR Gateway] WebSocket endpoint: ws://localhost:${port}${gatewayPath}`);
});

async function shutdown(signal) {
  console.log(`[App Server] Received ${signal}, shutting down`);
  clearInterval(auditCleanupTimer);
  clearInterval(captureCleanupTimer);
  clearInterval(audioCleanupTimer);
  await closeCaptureStore();
  gateway.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
