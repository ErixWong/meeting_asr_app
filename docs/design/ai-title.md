# 会议 AI 标题设计

> 沉淀自 `feat-261101-04-meeting-ai-title`（GitHub issue #44）。描述「会议结束后一键用 LLM 生成标题、
> 直接重命名、toast 可撤销一次」这条链路的实现口径，以及后续改动必须遵守的约束。

## 需求语义（用户已确认，不要再改设计）

会议结束后，在会议历史列表/详情里点「AI 起标题」：用 LLM 根据转写生成标题，**直接重命名该会议**
（**不做**预览确认弹窗），toast 里给**一次**撤销（undo）。

## 调用链路

```
前端 page.tsx  handleGenerateAiTitle(meetingId)
  → POST /api/meetings/:id/ai-title        （route.ts，BUSINESS_ROLES 鉴权）
  → admin-store.generateMeetingTitle(meetingId)
      → llmQueue.enqueue("title", …)       （既有队列：并发上限/容量/排队超时都复用）
      → generateMeetingTitleInner
          - ensureMeetingOwned              → 非本人/不存在 = AiTitleError 404
          - getMergedMeetingTranscript      → 无转写 = AiTitleError 409
          - 读设置 llm/base_url·api_key·model·max_tokens·timeout_ms（**不硬编码**）
          - buildTitlePrompt(模板, 正文)     → 正文按「开头 70% + 结尾 30%」窗口截断
          - llmTransport(...)               → 默认真实原生 http/https（llmRequest）
          - stripLeadingThinking → sanitizeMeetingTitle（清洗 + 空兜底）
          - withTransaction:
              UPDATE meetings SET title = ?
              INSERT meeting_llm_results (result_type = 'title', status = succeeded)
              writeAuditLog(llm.title, before/after title)
          - getMeetingLightById(meetingId)   → **与列表/详情同一个投影函数**
```

## 关键设计决策

### 1. 复用既有 llm 队列，任务类型 `"title"`

`src/lib/llm-queue.ts` 的 `LlmTaskType` 增加 `"title"`（排队预算 120s）。不另造调度：并发上限、
容量、排队超时、`inFlight/queued/dropped` 状态上报都跟纪要/翻译共用一套，运维只看一个队列。

### 2. **不走** `claimMeetingLlmGeneration`（不动会议状态机）

`claimMeetingLlmGeneration` 会把 `meetings.status` 推到 `llm_processing`，而它原本是「转写 → 生成纪要」
生命周期的状态。改标题如果也走 claim，会有两个问题：

1. **语义污染**：列表里会出现「生成中」闪烁、跟真正在跑的纪要生成抢状态（`WHERE status <> 'llm_processing'`
   的 claim 会 409），用户只是想改个名字；
2. **与需求冲突**：工单要求并发点击「后者覆盖前者即可」，而 claim 的语义是「前者占坑、后者 409 被拒」。

因此标题任务的状态机只落在 `meeting_llm_results` 这一行上：`succeeded` / `failed`，
会议本身的状态与 `last_error_message` 完全不动（失败只记账 + 审计，标题保持原样）。

### 3. 正文必须窗口化后送模型（不许整段 `raw_payload`）

1 小时会议正文约 3~5 万字，整段塞 prompt 会撑爆上下文、拖长首字延迟，而标题只需要主题信息。

- `selectTitleTranscript`：压掉换行/连续空白后，**超过 `TITLE_TRANSCRIPT_MAX_CHARS`（6000 字）** 时保留
  开头 70% + 结尾 30%，中间用 `……（会议过长，中间省略 N 字）……` 替代；
- 为什么不是「逐段多次调用 LLM 再汇总」：标题是「一句话概括」，多段汇总要多花 N 倍调用与 N 倍排队时间
  （还要跟纪要/翻译抢并发），收益不成正比；首尾窗口已经覆盖「开头交代主题 + 结尾给结论」这两个信息密集区；
- 口径可测：`scripts/ai-title-test.mjs` 在 4 万字正文里埋三个哨兵，断言**开头/结尾在 prompt 里、中段不在**，
  并且 prompt 长度 < 12000 字。

### 4. 输出清洗是硬要求（纯函数、可单测）

`sanitizeMeetingTitle(raw, fallback, maxChars = 30)`（`src/lib/ai-title.ts`，零依赖，可被测试直接 import）：

| 步骤 | 规则 |
| --- | --- |
| 换行 | `\r\n\t\u2028\u2029` → 空格 |
| 空白 | 连续空白压缩成单个空格，首尾 trim |
| 前缀 | 去掉「标题：」「会议主题:」这类前缀 |
| 引号 | 成对剥掉中英文引号/书名号/反引号（`"` `'` `“”` `‘’` `「」` `『』` `《》` `〈〉` `【】`），最多 4 轮 |
| 首尾标点 | 中英文标点/括号/Markdown 标记只剥**首尾**，中间的（如「Q3 目标：复盘」的冒号）保留 |
| 长度 | **按码点**（`Array.from`）截到 30，emoji 不会被切成半个代理对；截断后再清一次首尾标点 |
| 空兜底 | 清洗后为空 → 会议原名；原名也空 → 「未命名会议」。**绝不允许把会议名改成空串** |

「模型返回空 content」不当作清洗兜底，而是直接算失败（`LLM returned empty title`），避免写一条
「成功但标题没变」的记账。

### 5. `tpl-title` 必须**无条件**插入

`seedDefaults` 里 tpl-1/tpl-2 的种子包在 `if (templateCount === 0)` 里：**老库（已有任意模板）那一整块
根本不跑**，只靠种子会拿不到标题模板。所以 `ensureTitleTemplate(database, now)` 在种子函数末尾**无条件**执行：

- 语义：`INSERT … SELECT … WHERE NOT EXISTS (id = 'tpl-title' OR template_key = 'system_title')`
  —— **已有同名模板就不覆盖**（用户可能改过内容），缺失才插入；
- 因此不复用 `upsertPromptTemplate`（那是覆盖式 upsert，会冲掉用户改过的正文）；
- 运行期还有第二道保险：`generateMeetingTitleInner` 找不到模板时回落到代码里的 `TITLE_TEMPLATE_CONTENT`。

### 6. 记账与审计（`llm_call` 口径）

库里**没有** `llm_call` 表/函数，本项目既有的「LLM 调用记账」就是这两处，本单沿用、不新造：

1. `meeting_llm_results` 一行：`result_type = 'title'`、`status = succeeded|failed`、
   `generation_config_snapshot`（baseUrl/model/参数/正文窗口统计，**不含 api key**）、
   `raw_prompt`（窗口后的 prompt）、`raw_response`（截断 4000 字）、`version_no`；
2. `audit_logs` 一行：`action_type = 'llm.title'`，`before_snapshot.title` / `after_snapshot.title`，
   失败时 `result = 'failed'` + `error_message`。

⚠ `result_type = 'title'` 的行**不能**出现在「生成结果」版本列表与会议摘要里，所以：
`listMeetingLlmResultsByMeetingId` / `listMeetingLlmResultSummaries` 过滤 `result_type <> 'title'`，
`listMeetings` / `queryMeetingRowById` 的摘要子查询用 `result_type NOT IN ('translation','title')`。

### 7. 改名与 UI 状态必须同源（#43 R2 的教训）

接口返回的 `meeting` 就是 `getMeetingLightById()` 的产物 —— 与列表/详情**同一个投影函数**
（`mapMeetingRow` + `projectMeetingAudio`）。前端只走一个 `applyMeetingProjection(meeting)`：
同时更新 `meetings` 列表行与 `selected` 详情，避免「详情有、列表点进去没有」。

本单**没有**给 `meetings` 表加列（改标题复用既有 `title`），所以不涉及 schema 迁移；
「AI 生成的标题」这件事的可追溯性由 `meeting_llm_results` 的 `title` 行 + 审计保证。

### 8. 撤销（一次）的边界

- 撤销是**客户端一次性**能力：接口返回 `previousTitle`，前端 toast 里挂一个 `撤销` 按钮，
  点一次即 `PATCH /api/meetings/:id { title: previousTitle }`，然后 toast 换成不带动作的提示；
- 不做服务端 undo 栈：改标题本身可反复重命名，多级撤销属于「会议编辑历史」，不在本单范围；
- 刷新页面后 toast 消失 → 撤销入口随之消失（用户仍可用重命名按钮改回去）。

### 9. 并发

同一会议并发点击：两个请求都在队列里（并发上限内并行），各自在**一个事务**里做
`UPDATE meetings.title` + 记账 + 审计 —— 单条 UPDATE 天然原子，结果是「后写覆盖先写」，
不会出现「标题改了但没记账」或「记账了但标题没改」的半更新状态。

## 测试与注入口

- `src/lib/ai-title.ts` 零运行时依赖（`DatabaseSync` 只是 type-only import）→ 测试直接 import 真实源码；
- `admin-store.setLlmTransport(fn)`：**仅测试用**的传输层注入口，默认就是真实 `llmRequest`；
  `scripts/ai-title-test.mjs` 用它跑「真实 sqlite + 真实队列 + 真实记账，只有上游是桩」的完整链路，
  并且**不硬编码模型名/API key**（模型名从库里 `llm.model` 设置读出来再断言请求体）。

## 已知限制 / 遗留

- 真实上游 LLM 的质量（标题是否抓准主题）只能在真机上验证，单测只锁「发出去的 prompt 是窗口化的、
  回来的输出被清洗、失败不改标题」这些**可判定**的部分；
- `result_type = 'title'` 的行不进版本列表 → 前端「生成结果」页看不到标题的生成历史，
  要追溯得看审计日志（`llm.title`）；
- 标题模板 `tpl-title` 出现在后台「提示词模板」列表里，管理员改它会影响下一次生成（符合预期）。
