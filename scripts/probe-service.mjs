import dns from "dns/promises";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import WebSocket from "ws";

const DEFAULT_TARGET = "10.41.24.109:10095";
const arg = process.argv[2] || DEFAULT_TARGET;

function parseTarget(input) {
  if (input.includes("://")) {
    const url = new URL(input);
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80)),
      origin: input,
    };
  }

  const lastColon = input.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: input, port: 80, origin: input };
  }

  return {
    host: input.slice(0, lastColon),
    port: Number(input.slice(lastColon + 1)),
    origin: input,
  };
}

function withTimeout(promise, label, timeoutMs = 5000) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, kind: label, detail: `timeout after ${timeoutMs}ms` }), timeoutMs);
    }),
  ]);
}

async function probeDns(host) {
  try {
    const records = await dns.lookup(host, { all: true });
    return { ok: true, kind: "dns", detail: records.map((r) => `${r.address} (IPv${r.family})`).join(", ") };
  } catch (error) {
    return { ok: false, kind: "dns", detail: error.message };
  }
}

async function probeTcp(host, port) {
  return withTimeout(new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });

    socket.on("connect", () => {
      const elapsed = Date.now() - started;
      socket.end();
      resolve({ ok: true, kind: "tcp", detail: `connected in ${elapsed}ms` });
    });

    socket.on("error", (error) => {
      resolve({ ok: false, kind: "tcp", detail: `${error.code || "ERROR"} ${error.message}` });
    });
  }), "tcp");
}

async function probeTls(host, port) {
  return withTimeout(new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false });

    socket.on("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve({
        ok: true,
        kind: "tls",
        detail: `TLS ready, ALPN=${socket.alpnProtocol || "none"}, cert CN=${cert.subject?.CN || "unknown"}`,
      });
    });

    socket.on("error", (error) => {
      resolve({ ok: false, kind: "tls", detail: `${error.code || "ERROR"} ${error.message}` });
    });
  }), "tls");
}

async function probeHttp(host, port, path, secure = false) {
  const client = secure ? https : http;
  const kind = secure ? `https ${path}` : `http ${path}`;

  return withTimeout(new Promise((resolve) => {
    const req = client.request(
      {
        host,
        port,
        path,
        method: "GET",
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8").slice(0, 200).replace(/\s+/g, " ");
          resolve({
            ok: true,
            kind,
            detail: `status=${res.statusCode} server=${res.headers.server || "unknown"} body=${body || "<empty>"}`,
          });
        });
      }
    );

    req.on("error", (error) => {
      resolve({ ok: false, kind, detail: `${error.code || "ERROR"} ${error.message}` });
    });

    req.end();
  }), kind);
}

async function probeWebSocket(url) {
  return withTimeout(new Promise((resolve) => {
    const ws = new WebSocket(url);

    ws.on("open", () => {
      ws.close();
      resolve({ ok: true, kind: `ws ${url}`, detail: "handshake succeeded" });
    });

    ws.on("unexpected-response", (_, response) => {
      resolve({ ok: false, kind: `ws ${url}`, detail: `unexpected HTTP ${response.statusCode}` });
    });

    ws.on("error", (error) => {
      resolve({ ok: false, kind: `ws ${url}`, detail: error.message });
    });
  }), `ws ${url}`);
}

function printResult(result) {
  const status = result.ok ? "OK  " : "FAIL";
  console.log(`${status} ${result.kind.padEnd(18)} ${result.detail}`);
}

function summarize(results) {
  const tcp = results.find((item) => item.kind === "tcp");
  const httpRoot = results.find((item) => item.kind === "http /");
  const wsRoot = results.find((item) => item.kind.startsWith("ws ws://"));
  const wsPath = results.find((item) => item.kind.includes("/ws"));

  console.log("\nSummary:");
  if (!tcp?.ok) {
    console.log("- TCP 都没有建立成功，当前更像是端口未监听、目标主机拒绝连接，或网络策略拦截。");
    return;
  }

  if (wsRoot?.ok || wsPath?.ok) {
    console.log("- WebSocket 握手成功，目标服务像是 WebSocket 服务。");
    return;
  }

  if (httpRoot?.ok) {
    console.log("- 端口可达并返回了 HTTP 响应，目标更像是 HTTP 服务而不是纯 WebSocket 服务。");
    return;
  }

  console.log("- TCP 可达，但没有明显的 HTTP/WebSocket/TLS 特征，可能是私有二进制协议或需要特定握手。");
}

async function main() {
  const { host, port, origin } = parseTarget(arg);
  const wsBase = `ws://${host}:${port}`;
  const wssBase = `wss://${host}:${port}`;

  console.log(`Target: ${origin}`);
  console.log(`Host: ${host}`);
  console.log(`Port: ${port}`);
  console.log("");

  const results = [
    await probeDns(host),
    await probeTcp(host, port),
    await probeTls(host, port),
    await probeHttp(host, port, "/"),
    await probeHttp(host, port, "/ws"),
    await probeHttp(host, port, "/", true),
    await probeWebSocket(wsBase),
    await probeWebSocket(`${wsBase}/ws`),
    await probeWebSocket(wssBase),
    await probeWebSocket(`${wssBase}/ws`),
  ];

  results.forEach(printResult);
  summarize(results);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});