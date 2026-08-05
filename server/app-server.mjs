import { createServer } from "node:http";
import next from "next";
import { attachAsrGateway } from "./asr-gateway.mjs";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT || 3123);
const hostname = process.env.APP_HOST || "0.0.0.0";
const gatewayPath = process.env.ASR_GATEWAY_PATH || "/asr";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const handleUpgrade = app.getUpgradeHandler();

const server = createServer((request, response) => {
  handle(request, response);
});
const gateway = attachAsrGateway(server, {
  path: gatewayPath,
  devMode: dev,
  onUnhandledUpgrade: handleUpgrade,
});

server.listen(port, hostname, () => {
  console.log(`[App Server] ${dev ? "Development" : "Production"} server running on http://${hostname}:${port}`);
  console.log(`[ASR Gateway] WebSocket endpoint: ws://localhost:${port}${gatewayPath}`);
});

function shutdown(signal) {
  console.log(`[App Server] Received ${signal}, shutting down`);
  gateway.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
