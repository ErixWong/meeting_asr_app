/**
 * ASR 网关 Origin 判定（纯函数，无 IO、无全局状态）
 *
 * issue #61：非 `localhost` 访问时 `/asr` 的 WebSocket 握手被 403 拒绝，且 UI 静默。
 * 根因是 `docker-compose.yml` 的单值默认覆盖了网关内置的两值默认（localhost +
 * 127.0.0.1），于是 `127.0.0.1` / 局域网 IP / 域名访问全部被拒。
 *
 * 本模块把判定逻辑从 `asr-gateway.mjs` 抽出来，供网关与单测共用：
 *   - `parseOrigin` / `parseHostHeader`：归一化（小写、去结尾点、默认端口显式化）
 *   - `evaluateAsrOrigin`：判定入口，返回 allow/deny + 判定来源（白名单 / 同源 / 拒绝）
 *   - `resolveAllowedOrigins`：把 env 字符串解析成归一化白名单（空则回落到内置默认）
 *   - `describeAsrOriginDecision`：给运维看的单行结论（实际 Origin / Host / 生效白名单）
 *
 * 设计决策见 `docs/design/asr-gateway-origin.md`。
 */

/** http/https 的默认端口（显式化之后才能与 `Host` 里的「无端口」形态比较）。 */
const DEFAULT_PORTS = {
  "http:": 80,
  "https:": 443,
};

/** 内置默认白名单：只覆盖本机两种写法，跨机部署靠 D2 同源判定放行。 */
export function defaultAllowedOrigins(appPort) {
  const port = Number(appPort) > 0 ? Number(appPort) : 3123;
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

function stripTrailingDot(hostname) {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * 解析一个 origin 字符串（`http://host[:port]`）。
 *
 * 返回归一化结果：hostname 小写且去掉结尾点；端口显式化（缺省 http→80 / https→443）；
 * `origin` 是可比较的规范形式（默认端口不写回，`http://example.com:80` ≡ `http://example.com`）。
 * 非 http(s)、空串、非法 URL 一律返回 `null`。
 */
export function parseOrigin(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, url.protocol)) return null;

  const hostname = stripTrailingDot(url.hostname.toLowerCase());
  if (!hostname) return null;

  // URL 会把默认端口吃成空串（`http://example.com:80` → port === ""），
  // 所以「显式端口」与「默认端口」在 URL 层就统一了，这里只补默认值。
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (!Number.isInteger(port) || port <= 0) return null;

  return {
    protocol: url.protocol,
    hostname,
    port,
    // 规范化字符串：默认端口不写回（避免 `:80` 与无端口两种写法互相不匹配）
    origin: `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`,
  };
}

/**
 * 解析请求的 `Host` 头（形如 `127.0.0.1:3123`、`example.com`、`[::1]:3123`）。
 * 返回 `{ hostname, port }`，`port` 为 `null` 表示头里没写端口。
 */
export function parseHostHeader(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value);
  if (!match) return null;

  const hostname = stripTrailingDot(match[1]);
  if (!hostname) return null;

  const port = match[2] ? Number(match[2]) : null;
  if (port !== null && (!Number.isInteger(port) || port <= 0)) return null;

  return { hostname, port };
}

/**
 * 解析白名单字符串（逗号分隔）。逐项 trim、丢空项、归一化、去重（保序）。
 * 非法项（非 http/https、非 URL）直接丢弃 —— 一条写错的 env 不该让整份白名单失效。
 */
export function parseAllowedOrigins(raw) {
  const entries = String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseOrigin(item)?.origin)
    .filter(Boolean);
  return [...new Set(entries)];
}

/**
 * 计算当前生效的白名单：env 非空则以 env 为准（替换内置默认），
 * env 未配置 / 全为空项时回落到内置默认（D5：compose 默认留空，让这里生效）。
 */
export function resolveAllowedOrigins(raw, { appPort } = {}) {
  const parsed = parseAllowedOrigins(raw);
  return parsed.length > 0 ? parsed : defaultAllowedOrigins(appPort);
}

/**
 * 判定一次握手是否放行。
 *
 * 顺序（D3 → D2）：
 *   1. 缺 `Origin` 头 → 拒绝（不放宽安全面）
 *   2. `Origin` 归一化后命中显式白名单 → 允许（decision = "whitelist"）
 *   3. `Origin` 与请求 `Host` 同源（hostname 一致 + 有效端口一致）→ 允许（decision = "same-origin"）
 *   4. 其余 → 拒绝（decision = "deny"）
 *
 * ⚠ `localhost` 与 `127.0.0.1` 是**不同 hostname**，不互相算同源。
 *
 * @param {{origin?: unknown, host?: unknown, allowedOrigins?: string[]}} input
 * @returns {{
 *   allowed: boolean,
 *   decision: "whitelist"|"same-origin"|"deny",
 *   reason: "whitelist"|"same-origin"|"missing-origin"|"invalid-origin"|"cross-origin",
 *   actualOrigin: string|null,
 *   requestHost: string|null,
 *   allowedOrigins: string[],
 *   originParts: {protocol: string, hostname: string, port: number}|null,
 *   hostParts: {hostname: string, port: number|null}|null,
 * }}
 */
export function evaluateAsrOrigin({ origin, host, allowedOrigins = [] } = {}) {
  const whitelist = [...new Set(Array.isArray(allowedOrigins) ? allowedOrigins.filter(Boolean) : [])];
  const actualOrigin = typeof origin === "string" && origin.trim() ? origin.trim() : null;
  const requestHost = typeof host === "string" && host.trim() ? host.trim() : null;
  const originParts = parseOrigin(actualOrigin);
  const hostParts = parseHostHeader(requestHost);

  const base = {
    actualOrigin,
    requestHost,
    allowedOrigins: whitelist,
    originParts,
    hostParts,
  };

  if (!actualOrigin) {
    return { ...base, allowed: false, decision: "deny", reason: "missing-origin" };
  }

  if (!originParts) {
    return { ...base, allowed: false, decision: "deny", reason: "invalid-origin" };
  }

  if (whitelist.includes(originParts.origin)) {
    return { ...base, allowed: true, decision: "whitelist", reason: "whitelist" };
  }

  if (hostParts) {
    // Host 没写端口时，按 Origin 的协议推默认端口（http→80 / https→443）：
    // 反代常见 `Host: example.com`（外层 443）+ `Origin: https://example.com`，必须算同源。
    const hostPort = hostParts.port ?? DEFAULT_PORTS[originParts.protocol];
    if (hostParts.hostname === originParts.hostname && hostPort === originParts.port) {
      return { ...base, allowed: true, decision: "same-origin", reason: "same-origin" };
    }
  }

  return { ...base, allowed: false, decision: "deny", reason: "cross-origin" };
}

/**
 * 把判定结果渲染成一行日志（D4：拒绝日志必须打全 —— 实际 Origin、请求 Host、
 * 当前生效的白名单，以及「同源判定 / 白名单判定」的结论）。
 */
export function describeAsrOriginDecision(result) {
  const origin = result?.actualOrigin ?? "(missing)";
  const host = result?.requestHost ?? "(missing)";
  const whitelist = result?.allowedOrigins?.length ? result.allowedOrigins.join(", ") : "(empty)";
  const source = {
    whitelist: "命中显式白名单",
    "same-origin": "同源放行",
    "missing-origin": "拒绝：缺少 Origin 头",
    "invalid-origin": "拒绝：Origin 非法（需 http/https）",
    "cross-origin": "拒绝：既不在白名单、也不是同源",
  }[result?.reason] ?? "拒绝：未知原因";

  return `origin=${origin} host=${host} decision=${result?.decision ?? "deny"} (${source}) allowedOrigins=[${whitelist}]`;
}
