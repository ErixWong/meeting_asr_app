/**
 * ASR 网关 Origin 判定单测 + 真实握手端到端断言（issue #61）
 *
 * 覆盖：
 *   D7 纯函数（server/asr-origin.mjs）—— 同源放行 / 白名单优先 / 端口与 hostname 差异 /
 *      缺 Origin / 归一化（大小写、结尾点、默认端口）/ 白名单解析鲁棒性
 *   D8 端到端真实握手 —— 在临时端口 3197 上起临时实例（独立临时数据目录，不碰 :3123
 *      与项目 data/），用 ws 客户端带三种 Origin 打 /asr：
 *        同源 → 101；跨源未授权 → 403（且日志打全）；跨源已授权（env）→ 101
 *
 * 运行：npm run test:asr-origin（= node --test scripts/asr-origin-test.mjs，需 Node 24）
 * 说明：数据库与数据目录都落在 os.tmpdir() 沙箱里（进程 chdir 进去），收尾整目录删除。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const sandbox = mkdtempSync(join(tmpdir(), "asr-origin-test-"));
// 先 chdir 再加载服务端模块：sqlite 落点取 process.cwd()/data，保证写进沙箱
process.chdir(sandbox);

const load = (relativePath) => import(new URL(relativePath, import.meta.url).href);

const {
  parseOrigin,
  parseHostHeader,
  parseAllowedOrigins,
  resolveAllowedOrigins,
  defaultAllowedOrigins,
  evaluateAsrOrigin,
  describeAsrOriginDecision,
} = await load("../server/asr-origin.mjs");

const { attachAsrGateway } = await load("../server/asr-gateway.mjs");
const { getDb, closeDb } = await load("../server/db-shared.mjs");

// ---------------------------------------------------------------------------
// D8 端到端：临时实例（独立端口 + 独立数据目录）
// ---------------------------------------------------------------------------

const E2E_PORT = 3197;
const E2E_HOST = "127.0.0.1";
const DEV_ACCOUNT = "origin-e2e-admin";
const originalAllowedOriginsEnv = process.env.ASR_GATEWAY_ALLOWED_ORIGINS;

let httpServer = null;
let gateway = null;
let warnLines = [];
const originalWarn = console.warn;

/** 种一个 dev 模式可用的账号（网关 devMode 走 DEV_ACTOR_ACCOUNT 免 cookie）。 */
async function seedDevActor() {
  const db = await getDb();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (id, account_name, display_name, status, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run("user-origin-e2e", DEV_ACCOUNT, "Origin E2E", "active", 0, now, now);
  await db
    .prepare(`INSERT INTO roles (id, role_key, role_name, created_at) VALUES (?, ?, ?, ?)`)
    .run("role-origin-e2e", "user", "普通用户", now);
  await db
    .prepare(`INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)`)
    .run("user-role-origin-e2e", "user-origin-e2e", "role-origin-e2e", now);
}

before(async () => {
  delete process.env.ASR_GATEWAY_ALLOWED_ORIGINS; // 先跑「内置默认」形态
  process.env.DEV_ACTOR_ACCOUNT = DEV_ACCOUNT;
  await seedDevActor();

  httpServer = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  gateway = attachAsrGateway(httpServer, { path: "/asr", devMode: true });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(E2E_PORT, E2E_HOST, resolve);
  });
});

after(async () => {
  console.warn = originalWarn;
  gateway?.close();
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await closeDb();
  if (originalAllowedOriginsEnv === undefined) delete process.env.ASR_GATEWAY_ALLOWED_ORIGINS;
  else process.env.ASR_GATEWAY_ALLOWED_ORIGINS = originalAllowedOriginsEnv;
  delete process.env.DEV_ACTOR_ACCOUNT;
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * 带指定 Origin 打一次真实握手。
 * 返回 `{ status, opened, logLines }`：101 时 `opened` 为 true，非 101 时 `status` 是 HTTP 状态码。
 */
function handshake(origin) {
  warnLines = [];
  console.warn = (...args) => {
    warnLines.push(args.map((item) => String(item)).join(" "));
  };
  const headers = origin === null ? {} : { Origin: origin };

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${E2E_HOST}:${E2E_PORT}/asr`, { headers });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      console.warn = originalWarn;
      try {
        ws.terminate();
      } catch {
        /* 已关闭 */
      }
      resolve({ ...result, logLines: [...warnLines] });
    };

    ws.on("open", () => finish({ status: 101, opened: true }));
    ws.on("unexpected-response", (_req, res) => finish({ status: res.statusCode, opened: false }));
    ws.on("error", (error) => finish({ status: 0, opened: false, error: error.message }));
  });
}

test("D8-a: 同源 Origin（127.0.0.1:3197 对 Host 127.0.0.1:3197）真实握手 → 101", async () => {
  const result = await handshake(`http://${E2E_HOST}:${E2E_PORT}`);
  assert.equal(result.status, 101, `期望 101，实际 ${result.status}；日志=${result.logLines.join(" | ")}`);
  assert.equal(result.opened, true);
  console.log(`[D8-a] 同源握手 101（Host ${E2E_HOST}:${E2E_PORT}）`);
});

test("D8-b: 跨源未授权 Origin 真实握手 → 403，且日志含实际 origin 与生效白名单", async () => {
  const origin = "http://evil.example.com";
  const result = await handshake(origin);
  assert.equal(result.status, 403, `期望 403，实际 ${result.status}`);
  const line = result.logLines.find((item) => item.includes("Rejected client origin")) ?? "";
  assert.ok(line.includes(`origin=${origin}`), `日志缺少实际 origin: ${line}`);
  assert.ok(line.includes(`host=${E2E_HOST}:${E2E_PORT}`), `日志缺少请求 Host: ${line}`);
  // 生效白名单 = 网关内置默认（PORT 未设 ⇒ 3123 两值），逐项核对
  const expectedWhitelist = resolveAllowedOrigins(process.env.ASR_GATEWAY_ALLOWED_ORIGINS, {
    appPort: Number(process.env.PORT || 3123),
  });
  assert.ok(line.includes("allowedOrigins=["), `日志缺少白名单段: ${line}`);
  for (const entry of expectedWhitelist) {
    assert.ok(line.includes(entry), `日志缺少生效白名单项 ${entry}: ${line}`);
  }
  assert.ok(line.includes("cross-origin") || line.includes("既不在白名单"), `日志缺少判定结论: ${line}`);
  console.log(`[D8-b] 跨源未授权 403；日志原文：${line}`);
});

test("D8-c: 跨源但配进 env 白名单 Origin 真实握手 → 101", async () => {
  const origin = "https://meeting.example.com";
  process.env.ASR_GATEWAY_ALLOWED_ORIGINS = origin;
  try {
    const result = await handshake(origin);
    assert.equal(result.status, 101, `期望 101，实际 ${result.status}；日志=${result.logLines.join(" | ")}`);
    assert.equal(result.opened, true);
    console.log(`[D8-c] 白名单跨源握手 101（ASR_GATEWAY_ALLOWED_ORIGINS=${origin}）`);
  } finally {
    delete process.env.ASR_GATEWAY_ALLOWED_ORIGINS;
  }
});

test("D8-d: 缺 Origin 头真实握手 → 403（不放宽安全面）", async () => {
  const result = await handshake(null);
  assert.equal(result.status, 403, `期望 403，实际 ${result.status}`);
  const line = result.logLines.find((item) => item.includes("Rejected client origin")) ?? "";
  assert.ok(line.includes("origin=(missing)"), `日志应标注缺失 Origin: ${line}`);
  console.log(`[D8-d] 缺 Origin 403；日志原文：${line}`);
});

// ---------------------------------------------------------------------------
// D7 纯函数单测
// ---------------------------------------------------------------------------

const ORIGIN_PORT = 3197;
const WHITELIST = defaultAllowedOrigins(ORIGIN_PORT);

test("D7-1: 同源 http://127.0.0.1:3197 对 Host 127.0.0.1:3197 → 允许（same-origin）", () => {
  // 白名单刻意留空：放行只能来自 D2 同源判定
  const result = evaluateAsrOrigin({
    origin: `http://127.0.0.1:${ORIGIN_PORT}`,
    host: `127.0.0.1:${ORIGIN_PORT}`,
    allowedOrigins: [],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.decision, "same-origin");
  console.log(`[D7-1] ${describeAsrOriginDecision(result)}`);

  // D3：白名单与同源同时命中时，判定来源标成 whitelist（显式配置优先）
  const both = evaluateAsrOrigin({
    origin: `http://127.0.0.1:${ORIGIN_PORT}`,
    host: `127.0.0.1:${ORIGIN_PORT}`,
    allowedOrigins: WHITELIST,
  });
  assert.equal(both.allowed, true);
  assert.equal(both.decision, "whitelist");
});

test("D7-2: 跨源、不在白名单 → 拒绝", () => {
  const result = evaluateAsrOrigin({
    origin: "http://evil.example.com",
    host: `127.0.0.1:${ORIGIN_PORT}`,
    allowedOrigins: WHITELIST,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "cross-origin");
  console.log(`[D7-2] ${describeAsrOriginDecision(result)}`);
});

test("D7-3: 跨源、在白名单 → 允许（whitelist 优先）", () => {
  const result = evaluateAsrOrigin({
    origin: "https://meeting.example.com",
    host: `127.0.0.1:${ORIGIN_PORT}`,
    allowedOrigins: resolveAllowedOrigins("https://meeting.example.com", { appPort: ORIGIN_PORT }),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.decision, "whitelist");
  console.log(`[D7-3] ${describeAsrOriginDecision(result)}`);
});

test("D7-4: 端口不同（3197 vs 3198）→ 拒绝", () => {
  const result = evaluateAsrOrigin({
    origin: `http://127.0.0.1:${ORIGIN_PORT}`,
    host: `127.0.0.1:${ORIGIN_PORT + 1}`,
    allowedOrigins: [],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "cross-origin");
  console.log("[D7-4] 端口不同被拒绝 OK");
});

test("D7-5: http://localhost:3197 对 Host 127.0.0.1:3197 → 拒绝（不同 hostname 不算同源）", () => {
  const result = evaluateAsrOrigin({
    origin: `http://localhost:${ORIGIN_PORT}`,
    host: `127.0.0.1:${ORIGIN_PORT}`,
    // 白名单里也**只**有 127.0.0.1：确认放行不是白名单带来的
    allowedOrigins: [`http://127.0.0.1:${ORIGIN_PORT}`],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "cross-origin");
  console.log("[D7-5] localhost ≠ 127.0.0.1，未互相放行 OK");
});

test("D7-6: 缺 Origin 头 → 拒绝", () => {
  const missing = evaluateAsrOrigin({ origin: undefined, host: `127.0.0.1:${ORIGIN_PORT}`, allowedOrigins: WHITELIST });
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, "missing-origin");

  const empty = evaluateAsrOrigin({ origin: "   ", host: `127.0.0.1:${ORIGIN_PORT}`, allowedOrigins: WHITELIST });
  assert.equal(empty.allowed, false);
  assert.equal(empty.reason, "missing-origin");

  const invalid = evaluateAsrOrigin({ origin: "null", host: `127.0.0.1:${ORIGIN_PORT}`, allowedOrigins: WHITELIST });
  assert.equal(invalid.allowed, false);
  assert.equal(invalid.reason, "invalid-origin");
  console.log("[D7-6] 缺 Origin / 非法 Origin 均拒绝 OK");
});

test("D7-7: host 大小写、结尾点、默认端口归一化正确", () => {
  // 大小写 + 结尾点：Origin 与 Host 都归一化后一致
  assert.deepEqual(parseOrigin("HTTP://Example.COM.:80"), {
    protocol: "http:",
    hostname: "example.com",
    port: 80,
    origin: "http://example.com",
  });
  assert.deepEqual(parseHostHeader("EXAMPLE.com.:80"), { hostname: "example.com", port: 80 });

  // 默认端口等价：http://example.com ≡ http://example.com:80
  const defaultPort = evaluateAsrOrigin({
    origin: "http://example.com",
    host: "example.com:80",
    allowedOrigins: [],
  });
  assert.equal(defaultPort.allowed, true);
  assert.equal(defaultPort.decision, "same-origin");

  // https 走 443，Host 无端口时按 Origin 协议推默认端口（反代常见形态）
  const httpsProxy = evaluateAsrOrigin({
    origin: "https://meeting.example.com",
    host: "meeting.example.com",
    allowedOrigins: [],
  });
  assert.equal(httpsProxy.allowed, true);
  assert.equal(httpsProxy.decision, "same-origin");

  // 白名单里的写法同样归一化：大小写 / 结尾点 / 显式默认端口都能命中
  const whitelistHit = evaluateAsrOrigin({
    origin: "http://example.com",
    host: "127.0.0.1:3197",
    allowedOrigins: parseAllowedOrigins("HTTP://Example.COM.:80"),
  });
  assert.equal(whitelistHit.allowed, true);
  assert.equal(whitelistHit.decision, "whitelist");

  // IPv6 字面量 Host 可解析
  assert.deepEqual(parseHostHeader("[::1]:3197"), { hostname: "[::1]", port: 3197 });
  console.log("[D7-7] 归一化（大小写/结尾点/默认端口/IPv6）OK");
});

test("D7-8: 白名单含空格/空项的解析鲁棒性", () => {
  assert.deepEqual(
    parseAllowedOrigins(" http://a.example.com , ,http://b.example.com:80 ,,  "),
    ["http://a.example.com", "http://b.example.com"]
  );
  // 非法项被丢弃，不影响其它项
  assert.deepEqual(
    parseAllowedOrigins("not-a-url, ftp://c.example.com, http://d.example.com"),
    ["http://d.example.com"]
  );
  // 去重保序
  assert.deepEqual(parseAllowedOrigins("http://a.example.com,http://a.example.com:80"), ["http://a.example.com"]);
  // env 为空 / 全是空项 → 回落内置两值默认（compose 默认留空依赖这条）
  assert.deepEqual(resolveAllowedOrigins(undefined, { appPort: 3123 }), [
    "http://localhost:3123",
    "http://127.0.0.1:3123",
  ]);
  assert.deepEqual(resolveAllowedOrigins(" , ,", { appPort: 3123 }), [
    "http://localhost:3123",
    "http://127.0.0.1:3123",
  ]);
  // env 非空 → 以 env 为准（替换内置默认）
  assert.deepEqual(resolveAllowedOrigins("https://meeting.example.com", { appPort: 3123 }), [
    "https://meeting.example.com",
  ]);
  console.log("[D7-8] 白名单解析（空格/空项/非法项/去重/默认回落）OK");
});

test("D7-9: 拒绝日志包含实际 origin、请求 Host、生效白名单与判定结论", () => {
  const result = evaluateAsrOrigin({
    origin: "http://127.0.0.1:3123",
    host: "127.0.0.1:3123",
    allowedOrigins: ["http://localhost:3123"],
  });
  // 同源判定生效 → 允许；把 Host 换成别的才拒绝
  assert.equal(result.allowed, true);

  const denied = evaluateAsrOrigin({
    origin: "http://127.0.0.1:3123",
    host: "meeting.example.com",
    allowedOrigins: ["http://localhost:3123"],
  });
  const line = describeAsrOriginDecision(denied);
  assert.ok(line.includes("origin=http://127.0.0.1:3123"));
  assert.ok(line.includes("host=meeting.example.com"));
  assert.ok(line.includes("http://localhost:3123"));
  assert.ok(line.includes("既不在白名单"));
  console.log(`[D7-9] 日志原文：${line}`);
});
