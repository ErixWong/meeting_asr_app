# 性能与数据架构设计约束

> 来源：docs-260805-02 分析 + fix-260805-03 修复（round01-07），2026-08-05 放行沉淀。
> 适用范围：本文件记录已确认的长期结构约束，后续任务必须遵循；与既有 `auth-permissions-and-tenant-isolation.md`、`llm-generation-pipeline.md` 冲突时以更具体者为准。

## 1. ASR 捕获事件写入：内存队列 + 批量落库

- **约束**：`appendCaptureEvent` 只做内存入队（限额 10000 条 / 512KB 单条 / 8MB 总量在内存判定），**热路径不得出现同步 DB 调用**。
- 落库由 `flushCaptureEvents` 批量执行（定时 500ms + 会话 finish 强制 + `createMeeting`/`appendMeetingTranscript` 读取前排空 `drainCaptureEvents`）。
- 丢失容忍：崩溃丢失窗口 ≤ flush 间隔，仅影响捕获统计（事件明细已不保留，见第 5 条）；转写文本直通客户端不受影响。
- **禁止**：任何人不得把 `appendCaptureEvent` 改回同步写库；不得让 flush 与 `withTransaction` 异步交错（同连接同步事务互斥是安全前提）。

## 2. SQLite：单连接 + WAL

- 全进程**单一** `DatabaseSync` 连接（`server/db-shared.mjs`），业务与网关共享；禁止再开第二连接（busy timeout=0 下双连接抢锁会抛 SQLITE_BUSY）。
- `journal_mode=WAL` 必须保持（bind mount 环境验证失败时改 named volume，不得静默降级）；`synchronous` 保持 FULL。
- 高频语句做模块级预编译缓存（`getPreparedStatements` 模式）。

## 3. 读路径分层：light / full

- `getMeetingById`（full，含 transcript）仅用于详情展示与写路径返回值；`getMeetingLightById`（无 transcript）用于轮询、列表、状态刷新（`?view=light`）。
- 会议列表永不读取逐会议 payload；llm-results 列表永不返回 `raw_prompt`/`raw_response` 大字段。
- 写路径返回值若仅作回显，优先 light 语义（轮询场景前端用合并更新保留已有 transcript）。

## 4. 资源归属校验：ensureMeetingOwned 统一入口

- 所有按 meetingId 读取/变更的导出函数必须先过 `ensureMeetingOwned`（不归属返回 null → 路由 404；DELETE 语句同时带 `created_by_user_id` 条件）。
- 新增 meeting 相关接口必须遵循；`deleteMeeting` 的 DELETE 不得移除 owner 条件。

## 5. raw_payload：结构化会话摘要（事件明细不保留）

- `meeting_asr_results.raw_payload` 只存：`{ captureSessionId, taskId, status, asrProvider, eventStats, speakerIds, transcriptSegments }`。
- **事件明细（逐条 ASR 消息）不入库**（用户拍板：无呈现价值）；会话统计由 `captureStats` 在网关入队时内存累计（`getCaptureSessionStats` 取快照），不回溯历史行。
- 会议保存成功后删除 `asr_capture_sessions` 行（级联清事件表残留）并 `releaseCaptureSession` 释放内存（事务提交后调用）。
- 若未来需要事件回放能力，须先评估统计摘要能否覆盖，再单独设计存储。

## 6. 审计日志原则

- 审计只记"谁、何时、对什么、做了什么"（操作元数据），**正文不进审计**（meeting 快照 light 化、llm 结果快照去正文、settings secret 脱敏）。
- 保留期默认 30 天（`cleanupExpiredAuditLogs`，启动 + 每日定时）；`meeting.transcript.append`（自动 checkpoint）不写审计。

## 7. 交互路径异步、启动路径同步

- 密码哈希：交互路径（登录/改密/建用户/重置）一律 `crypto.scrypt` 异步版；`hashPasswordSync`（scryptSync）仅限 `getDb()` 初始化种子路径，新增用途需审计。
- LLM 生成：`POST llm-results` 经 `claimMeetingLlmGeneration` 原子 claim 后立即返回（fire-and-forget），冲突返回 409；前端依赖 llm_processing 轮询（light 查询）。防重入后端 claim 是唯一权威保障。
- 事务回调内禁止 await（哈希等重计算必须在 `withTransaction` 外提前完成）。

## 8. 运行时配置缓存（单进程约定）

- `getAsrRuntimeConfig` 进程内缓存，`saveSettings`/热词增删改后 `invalidateAsrRuntimeConfig` 失效。
- **多实例部署前提**：本约定依赖单进程共享内存；拆分多实例时必须改为共享失效机制（届时评估）。

## 9. 网关失败语义

- 明确失败优于静默丢弃：上游连接 10s 超时、pendingAudio 120 块上限、send 缓冲 16MB 上限，均以 `session.failed` 明确报错并 `failSession` 幂等收敛（`sessionFailed`/`sessionFinished` 标志）。
- 会话级维护（capture cleanup）走 app-server 定时器，不在连接路径执行。
