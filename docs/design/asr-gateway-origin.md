# ASR 网关 Origin 判定（issue #61）

> 状态：已实现（`fix-261101-03-asr-ws-origin`）
> 代码：`server/asr-origin.mjs`（纯函数）、`server/asr-gateway.mjs`（调用与日志）、
> `scripts/asr-origin-test.mjs`（单测 + 真实握手端到端）

## 1. 问题

用**非 `localhost`** 地址打开系统（`http://127.0.0.1:3123`、局域网 IP、域名 / 反向代理都算），
点「开始录音」后：

```
WebSocket connection to 'ws://…/asr' failed: Unexpected response code: 403
[ASR Gateway] Rejected client origin: http://127.0.0.1:3123
```

浏览器控制台只有 `FunASR error: WebSocket connection failed`，**页面没有任何持续提示** ——
用户以为在录，实际整场会议既没有转写、也没有录音文件（PCM 是在网关里旁路落盘的，WS 不通就什么都没有）。

根因是两处默认值互相覆盖：

| 位置 | 默认值 |
|:---|:---|
| `server/asr-gateway.mjs`（改前） | `http://localhost:${PORT},http://127.0.0.1:${PORT}`（**两值**） |
| `docker-compose.yml`（改前） | `${ASR_GATEWAY_ALLOWED_ORIGINS:-http://localhost:3123}`（**单值**） |

compose 的单值默认把网关内置的两值默认整个覆盖掉，于是 `127.0.0.1` 被排除；
跨机部署时 Origin 是公网域名，同样中招，而部署文档没写这件事。

## 2. 判定规则（D1-D5）

判定入口是纯函数 `evaluateAsrOrigin({ origin, host, allowedOrigins })`，网关只负责
取 `Host` / `Origin` 头、取生效白名单、打日志。

判定顺序：

1. **缺 `Origin` 头 → 拒绝**（`reason = "missing-origin"`，不放宽安全面）。
   非法 Origin（非 http/https、非 URL）→ 拒绝（`reason = "invalid-origin"`）。
2. **显式白名单命中 → 允许**（`decision = "whitelist"`）。白名单来源是
   `ASR_GATEWAY_ALLOWED_ORIGINS`（逗号分隔），非空时**替换**内置默认。
3. **同源 → 允许**（`decision = "same-origin"`）：`Origin` 的 hostname 与有效端口
   （显式端口，否则 http→80 / https→443）与请求 `Host` 归一化后完全一致。
4. 其余 → 拒绝（`decision = "deny"`, `reason = "cross-origin"`）。

⚠ `localhost` 与 `127.0.0.1` 是**不同 hostname**，不互相算同源（单测 `D7-5` 钉死）。

同源判定的价值：IP 访问、域名访问、换端口部署都**不需要每次配 env**；
白名单只留给「反向代理内外层 host 不一致」这类真正跨域的场景。

### 归一化细节

| 输入 | 归一化结果 |
|:---|:---|
| `HTTP://Example.COM.:80` | `http://example.com`（小写 + 去结尾点 + 默认端口不写回） |
| `Host: EXAMPLE.com.:80` | `{ hostname: "example.com", port: 80 }` |
| `Host: example.com`（无端口） | 端口按 `Origin` 的协议推默认（http→80 / https→443） |
| `Host: [::1]:3197` | `{ hostname: "[::1]", port: 3197 }` |

白名单解析（`parseAllowedOrigins`）：逐项 trim、丢空项、归一化、去重保序；非法项丢弃
（一条写错的 env 不该让整份白名单失效）；env 未配置或全是空项时回落到内置两值默认
（`http://localhost:<PORT>`, `http://127.0.0.1:<PORT>`）。

### 生效白名单是热读的

网关按 `ASR_GATEWAY_ALLOWED_ORIGINS` 的原始字符串做记忆化：值没变就不重复解析。
好处是改 env 不必重启进程，也让单测能在同一进程里换白名单跑真实握手（D8）。

## 3. 拒绝日志（D4）

拒绝日志一行打全：**实际 Origin、请求 Host、当前生效白名单、判定结论（同源还是白名单）**：

```
[ASR Gateway] Rejected client origin: origin=http://evil.example.com host=127.0.0.1:3197 \
  decision=deny (拒绝：既不在白名单、也不是同源) allowedOrigins=[http://localhost:3123, http://127.0.0.1:3123]
```

运维据此可以直接判断「该配什么」：`origin` 与 `allowedOrigins` 一对就知道要不要加白名单。

## 4. 部署默认值（D5）

`docker-compose.yml` 改为 `ASR_GATEWAY_ALLOWED_ORIGINS: ${ASR_GATEWAY_ALLOWED_ORIGINS:-}`：

- 默认留空 ⇒ 网关内置两值默认 + 同源判定生效，`127.0.0.1` / 局域网 IP / 域名访问开箱可用；
- **不许**在 compose 里硬编码与机器相关的 origin（单值默认正是这次的坑）。

## 5. UI 侧（D6）

WS 不可用时页面**必须持续可见地**告警，而不是 3.5 秒就消失的 toast：

- 顶部常驻红色告警条：**「实时转写连接失败：本次会议不会生成转写，也不会保存录音文件。」**
  + 原因（`error.message`）+ 可行动线索（地址/Origin 白名单、ASR 服务连通性）；
- 连接恢复、重新开始录音、主动停止时自动消失（也允许用户手动关闭）；
- 录音状态行不再只显示「录音中 00:xx」：链路不通时追加「（实时转写未连接）」，
  且 `FunASR` 一栏显示「未连接」（红色）。

实现要点：`page.tsx` 新增 `asrLinkError` 状态 + `asrStopIntentRef`（区分「用户主动停止」
与「链路故障」，避免停止录音时的 `onclose` 被误报成断开告警）。没有引入新依赖，
未改 `src/lib/funasr.ts`（它已提供 `onStatusChange("disconnected")`）。

## 6. 测试

`npm run test:asr-origin`（`scripts/asr-origin-test.mjs`，13 例）：

- **D7 纯函数 9 例**：同源放行、跨源拒绝、白名单放行、端口不同拒绝、
  `localhost` vs `127.0.0.1` 拒绝、缺/非法 Origin 拒绝、归一化（大小写/结尾点/默认端口/IPv6）、
  白名单解析鲁棒性（空格/空项/非法项/去重/默认回落）、日志字段完整性。
- **D8 真实握手 4 例**：临时实例跑在 `127.0.0.1:3197`（独立临时数据目录，不碰 `:3123`
  与项目 `data/`），用 `ws` 客户端带不同 Origin 打 `/asr`：
  同源 → 101；跨源未授权 → 403（并断言日志含实际 origin / Host / 生效白名单）；
  跨源已授权（env）→ 101；缺 Origin → 403。

变异验证（报告 `docs/tasks/active/fix-261101-03-asr-ws-origin/report.md` 有原文）：

1. 去掉同源判定 → `D7-1` 与 `D8-a` 必须失败；
2. 还原成改前的「单值白名单 + 无同源」形态 → `D8-a` 的同源握手必须变成 403。
