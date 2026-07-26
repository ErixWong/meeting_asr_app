# 260724 Improve - Meeting Lifecycle

## 1. 目标

定义会议对象的生命周期状态、状态流转规则以及前后端需要配合的行为，作为后续列表页、详情页、发送流程、重解析流程和审计能力的统一基础。

## 2. 为什么需要状态机

当前原型只有“录音”和“生成纪要”的局部状态，没有完整的会议业务状态。正式产品需要一套稳定状态模型，否则会出现以下问题：

1. 会议列表无法准确筛选。
2. 失败场景无法区分是转写失败、LLM 清洗失败还是发送失败。
3. 邮件发送、重解析、归档之间缺少明确边界。
4. 审计和运维难以判断当前卡在哪个环节。

## 3. 会议对象建议模型

会议对象建议至少包含以下业务维度：

1. 基本信息：标题、创建人、开始时间、结束时间、时长、来源类型。
2. 内容信息：原始 ASR、LLM 清洗结果版本。
3. 分发信息：发送记录。
4. 运行信息：当前状态、失败原因、最近操作时间。

说明：

1. `meetings.status` 只描述会议自身流程阶段。
2. 某一版 LLM 清洗结果的生成状态，应落在 `meeting_llm_results.status`。
3. 某次邮件发送状态，应落在 `meeting_send_records.status`。

## 4. 建议状态定义

### `draft`

含义：

- 会议已创建，但尚未开始录音或尚未上传音频。

### `recording`

含义：

- 正在实时录音并进行流式 ASR。

### `transcribing`

含义：

- 录音已停止，系统正在整理转写结果。
- 对上传音频场景，也可以表示文件识别进行中。

### `transcribed`

含义：

- ASR 已完成，原始 ASR 结果已保存。
- 此时会议内容已可查看，但首份 LLM 清洗结果可能尚未生成。

### `llm_processing`

含义：

- 正在调用 LLM 生成默认结果或手动重生成结果。

说明：

- 如果一个会议允许生成多个结果版本，当前状态代表“当前有清洗任务在进行中”，不表示旧结果不可用。

### `pending_review`

含义：

- 已生成至少一版 LLM 清洗结果，等待用户查看、选择版本、确认收件人。

### `sending`

含义：

- 正在发送邮件。

### `sent`

含义：

- 已成功发送至少一次。

说明：

- 如果允许再次发送，不必因为补发而离开这个状态。

### `archived`

含义：

- 会议已归档，不再属于活跃处理中对象。

### `transcribe_failed`

含义：

- ASR 流程失败，未拿到可用转写结果。

### `llm_failed`

含义：

- 会议已完成转写，但默认 LLM 清洗失败。

说明：

- 这种情况下会议内容仍应保留，允许手动重试。

### `send_failed`

含义：

- 邮件发送失败。

说明：

- 失败后应保留 LLM 结果版本和收件人信息，便于修正后重发。

## 5. 建议主状态流

### 路径 A：实时录音

`draft` -> `recording` -> `transcribing` -> `transcribed` -> `llm_processing` -> `pending_review` -> `sending` -> `sent` -> `archived`

### 路径 B：上传音频

`draft` -> `transcribing` -> `transcribed` -> `llm_processing` -> `pending_review` -> `sending` -> `sent` -> `archived`

### 路径 C：默认 LLM 清洗失败

`transcribed` -> `llm_processing` -> `llm_failed`

后续恢复路径：

`llm_failed` -> `llm_processing` -> `pending_review`

### 路径 D：发送失败

`pending_review` -> `sending` -> `send_failed`

后续恢复路径：

`send_failed` -> `sending` -> `sent`

### 路径 E：转写失败

`recording` -> `transcribing` -> `transcribe_failed`

## 6. 手动重解析与状态关系

手动重解析建议不改变会议的大阶段，只影响 `meeting_llm_results`。

例如：

1. 会议当前处于 `pending_review`。
2. 用户选择其他模板重新解析。
3. 系统短暂进入 `llm_processing`。
4. 成功后仍回到 `pending_review`。

结论：

1. 会议状态用于描述“会议整体流程”。
2. `meeting_llm_results.status` 用于描述“某一版 LLM 清洗结果的生成过程”。

## 7. 一期建议的简化状态集

如果一期不想做过细状态，建议最小保留：

1. `draft`
2. `recording`
3. `transcribed`
4. `pending_review`
5. `sent`
6. `archived`
7. `transcribe_failed`
8. `llm_failed`
9. `send_failed`

## 8. 详情页与列表页建议

### 列表页

建议支持按状态筛选：

- 待处理
- 待确认
- 已发送
- 失败
- 已归档

### 详情页

建议根据状态控制按钮：

1. `draft`
   - 开始录音
   - 上传音频
2. `transcribed`
   - 生成首份结果
3. `pending_review`
   - 查看结果
   - 重新解析
   - 确认收件人
   - 发送邮件
4. `send_failed`
   - 查看失败原因
   - 重新发送
5. `archived`
   - 查看
   - 再次发送
   - 重新解析

## 9. 审计建议

建议记录关键状态流转日志：

1. 谁创建了会议。
2. 谁开始/结束录音。
3. 谁触发了默认 LLM 清洗。
4. 谁手动重新解析。
5. 谁发送了邮件。
6. 谁归档了会议。

## 10. 与现有文档的关系

1. [数据库设计](./schema-design.md)
   具体状态字段落库方式以数据库设计为准。
2. [API 设计](./api-design.md)
   需要在会议保存、LLM 清洗、邮件发送接口中体现状态变更。
3. [产品改进计划](./product-improvement-plan.md)
   这里落实了其中“会议状态机”的设计要求。
