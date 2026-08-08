# LLM 全局队列与翻译体系

> 状态: 已实施（PR #20/#21，2026-08-08）
> 范围: 全局 LLM 并发控制、实时翻译触发策略、翻译持久化、页面高度链约束

## 1. 全局 LLM 队列（llm-queue.ts）

**背景**：翻译、纪要生成、手动生成、测试共用同一 LLM 后端（本地 qwen 或远端 OpenAI 兼容服务），多用户并发会把模型打满。

**设计**：进程内信号量 + FIFO 队列，**所有 LLM 调用统一过闸**（翻译/纪要/手动/测试）：

- 并发上限 = `llm:max_concurrency`（默认 2，admin 可调，入队时读取即改即生效）
- 排队容量 = `llm:queue_capacity`（默认 10），超出直接拒绝（浅队列快速失败）
- 排队等待上限：translate/test 30s、summary 180s（异步长任务，超时返回"LLM 繁忙"）
- 单例挂 `globalThis`（防 dev HMR 重置）；槽位持有到 SSE 流结束（`finally` 释放）
- 纪要生成（fire-and-forget + 写库轮询）接队列零返回路径改动；手动触发路径排队超时恢复会议状态（`llm_failed`）

**关键约束**：

- **禁止嵌套入队**：队列任务内部不得再次 enqueue（历史翻译管线外层占槽后，内层批直连 `translateSentences`，串行执行）——嵌套会在多任务并发时因槽位被外层占用导致 30s 排队超时必失败
- 单进程成立（自定义 server 单实例）；多实例部署需 Redis 协调（已知边界，未实现）
- 队列状态 `GET /api/llm-queue-status`（BUSINESS_ROLES）：`{inFlight, queued, dropped}`，录音页徽章与 admin 面板共用

## 2. 实时翻译触发策略

**事实基础**：服务端无 VAD 事件，每个 `transcript.final` 即 ASR 切好的一句话（FunASR `is_final`/DashScope `sentence_end`）。

**规则**（前端 page.tsx）：

- 只缓冲 final（partial 绝不送翻）；缓冲满 N 句（`llm:translate_trigger_sentences`，默认 3，可调小更实时）或距上次 10s 触发一次
- in-flight 守卫 + 会话代数（`translateGenerationRef`）防竞态；失败不清缓冲（2000 字截断最早），下次触发自动重发
- 停止录音强制 flush（force 绕过阈值）；源=目标语言自动切换目标语言
- 语种选择影响：asrLang 与 targetLang 相同（非 auto）时不翻译

**耗时观测**：`/api/translate` 返回 `elapsedMs`（仅 LLM 调用阶段，排除排队），译文面板徽章显示"最近 Xs"用于跟踪模型速度。

## 3. 翻译持久化与历史再次翻译

**核心决策：零 schema 迁移，复用 `meeting_llm_results` 版本化存储。**

- 系统翻译模板 `system_translate`（id=`tpl-translate`，`template_type='translation'`）无条件 upsert，绕过 `prompt_template_id NOT NULL + FK`
- 翻译行：`result_type='translation'`（自动继承模板类型）、`version_no` 全局递增（多语言并存一个版本流）、`input_transcript_snapshot` 存原文快照、`generation_config_snapshot` 存 `{targetLang, source:"live"|"manual"}`（数据层记语言，UI 不标）
- 实时入库 `POST /api/meetings/:id/live-translation`：纯持久化（译文已是成品，零 LLM 调用），录音停止保存会议后自动写入；raw_prompt 空串满足 NOT NULL
- 历史翻译 `translateMeetingFlow`：final 句分批（≤5 句/≤1000 字）→ 串行直连 `translateSentences` → 全成写 succeeded / 任批失败写 failed（含错误信息，可重试）
- 前端：转录 tab 目标语言 + 翻译按钮 + 版本按钮行（V1/V2...，失败红/处理中琥珀）+ 版本切换/删除；生成走 `llm_processing` 状态复用现有 2s 轮询
- 类型隔离：summary tab 只显示纪要版本（`result_type !== 'translation'`），互不污染
- **`meeting.summary` 派生字段约束**：`listMeetings` / `queryMeetingRowById` 的 summary 子查询
  是"最新成功结果"（`status='succeeded'` 按 version_no 降序取 1 条），必须排除
  `result_type='translation'`，否则翻译版本号更大时会把 `summary` 顶替成译文，
  导致"会议纪要 tab 正文区显示译文、版本列表却没有译文"的错位（fix-260808-01）。
  新增其他 resultType（如清洗/总结变体）时，需评估该子查询是否同样排除。

**版本号并发安全**：`getNextLlmVersionNo` 在 `withTransaction` 内 MAX+1，实时入库与纪要/翻译生成并发无冲突。

## 4. 页面高度链约束（全局布局）

**背景**：ASR 文本积累导致页面撑高、出现滚动条。

**根因**：layout 容器 `min-h-screen` 是 auto 高度，`h-full` 百分比链整体失效。

**修复**：layout 容器改 `h-screen`（确定高度链），admin 页根容器 `overflow-y-auto` 容器内滚动，login/change-password 加 `overflow-y-auto` 兜底。**约定：页面级容器高度一律依赖 `h-screen` 链 + `min-h-0` flex 子项，禁止依赖 `min-h-screen` 下的 `h-full`。**

## 5. 其他实施细节

- SenseVoice 标签（`<|lang|><|emotion|><|event|>`）在网关层剥离（新数据干净入库），渲染层兜底（历史数据）；原始消息保留在 capture events
- 翻译/纪要生成均经队列但类型区分（translate/summary/test），观测面板按聚合数字展示
