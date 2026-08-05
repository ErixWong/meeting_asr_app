# LLM 生成链路设计

> 沉淀自 `refactor-260801-01-llm-call-settings`。描述会议纪要生成的 LLM 调用链路、为何这样设计、以及后续改动必须遵守的约束。

## 调用链路

```
前端 POST /api/meetings/:id/llm-results
  → route.ts（角色校验 BUSINESS_ROLES）
  → admin-store.ts createMeetingLlmResult
      - 读设置：llm/base_url, api_key, model, context_size, max_tokens, timeout_ms
      - 构建 prompt（模板 {transcript} 替换），context_size 超长按 UTF-16 安全截断
      - llmRequest（原生 http/https）发起流式请求
      - 流式读取 SSE，onData 实时进度日志
      - parseSseText 解析 content / reasoning_content / finish_reason
      - 落库 meeting_llm_results，更新会议状态，写审计日志
```

## 关键设计决策

### 1. SSE 流式调用（stream: true）而非单次调用

- **原因**：部署环境 qwen.local:8080 为 nginx 反代，其 `proxy_read_timeout` 按"两次读取空闲间隔"计时。非流式下 LLM 长生成期间不发送字节，超时即 504。SSE 持续输出 token，读操作不断，绕开超时。
- **约束**：响应头必须带 `Accept: text/event-stream`；请求体 `stream: true`。
- **结果语义**：后端流式读完整个 SSE 再写库，前端 POST 仍同步等待（无前端流式进度）。

### 2. 原生 node:http/https 而非全局 fetch（undici）

- **原因**：Node 内置 fetch（undici）有不可被 AbortController 覆盖的默认 `headersTimeout: 300s`，长生成会先于自定义超时被掐（报 `fetch failed`）。原生 http 无默认超时，超时只受 `timeout_ms` 控制。
- **约束**：`llmRequest` 内部用 `res.on("data")` 流式收集（天然支持 SSE）；`StringDecoder` 处理 UTF-8 分块；AbortSignal abort 时 reject `AbortError`（name="AbortError"）以区分超时与其他错误。

### 3. 设置项配置化，不写死

- `context_size`：发送文本截断长度（字符），留空不截断，截断用 `truncateUtf16` 防 emoji 半字符。
- `max_tokens`：留空则不发送该字段，由 LLM 自行决定（避免 thinking 模式吃光预算返回空 content）。
- `timeout_ms`：留空默认 180000。
- **约束**：新增 LLM 配置项必须同步五处——seedDefaults（admin-store）、state、`settingsPayload`（含 useMemo deps）、加载 `get()`、JSX 输入框（admin/page.tsx）。

### 4. 错误分级与"可能不完整"标记

- **失败**（content 为空 / 网络错 / 非 2xx / 超时）：落库 status=failed，`error_message` 带 cause + elapsed，保留 raw_response 截断。
- **成功但截断**（`finish_reason=length` 且 content 非空）：落库 status=succeeded，但 `error_message` 写"结果可能不完整"，前端内容区头部 ⚠️ 展示。
- **reasoning_content 不写入 resultMarkdown**：只统计字符数（日志），thinking 不污染纪要内容。

## 日志契约（`[LLM]` 前缀）

| 日志 | 时机 | 用途 |
|------|------|------|
| `generate` | 请求前 | model/url/promptChars/配置 |
| `stream: first SSE event at Xms` | 首个 SSE 事件 | 证明流式生效（无此行=上游未流式/未开始处理） |
| `stream: tokens=N elapsed=Xms` | 每 50 token | 生成进度 |
| `headers` | 收到响应头 | SSE 下应秒回 |
| `body` | 流读完 | 流式总时长 |
| `parsed` | 解析完 | chunks/finishReason/content/reasoning 字符数 |
| `failed` | 异常 | cause + elapsed |

## 排错速查

| 现象 | 根因方向 |
|------|----------|
| `LLM returned empty result (finishReason=length)` | thinking 吃光 max_tokens → 调大或不设 max_tokens |
| `fetch failed` / `LLM network error` | undici 300s（旧）或网络断；现在原生 http 无此隐患，看 cause |
| 504 nginx | 上游 proxy_read_timeout；SSE 下应消除，否则查上游是否忽略 stream 或排队 |
| 无 `first SSE event` 日志 | 上游忽略 stream / 未开始处理（llama.cpp 串行队列） |

## 已知差异 / 遗留

- `test-llm/route.ts` 仍用全局 fetch（短 prompt + 只查 response.ok，无实际影响）。
- SSE 中途断流时，已接收部分内容会丢弃（`rawText` 未赋值）——见任务 `round02-audit` 变更项 #1。
