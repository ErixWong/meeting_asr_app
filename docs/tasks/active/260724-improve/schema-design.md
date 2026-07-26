# 260724 Improve - Schema Design

## 1. 目标

为会议纪要系统提供单机 SQLite 持久化方案，覆盖：

1. 运行期配置持久化
2. 模板资源持久化
3. 热词表持久化
4. 会议主记录持久化
5. 原始 ASR 结果持久化
6. LLM 清洗结果持久化
7. 邮件发送记录持久化

## 2. 设计原则

1. 系统配置、模板资源、会议事实、衍生结果分开建模。
2. 配置和业务数据都落 SQLite，不再依赖 `.env.local` 作为运行期配置源。
3. 模板是独立业务资源，不再塞进 `app_settings`。
4. 原始 ASR、LLM 清洗结果、发送记录按链路分层保存，保证可回溯。
5. 结构优先服务当前单机应用，不提前引入过度复杂的抽象。

## 2.1 第一性原则

围绕本次重设计，建议强制遵守以下原则：

1. 一个运行期事实只允许一个真相源。
2. 用户填写的系统参数与可被引用的业务资源要分开建模。
3. 离原始数据最近的组件负责采集，业务 API 负责持久化。
4. 持久化事实与衍生结果必须分阶段提交，不能用单事务硬绑。

对应到当前问题：

1. 当前生效配置只保存在 `app_settings` 中。
2. LLM 清洗模板只保存在 `llm_prompt_templates` 中。
3. 热词表只保存在 `asr_hotwords` 中。
4. 原始 ASR 事件由代理采集，通过 `capture_session_id` 交给业务 API 落库。
5. 会议保存先提交，默认 LLM 清洗在提交后单独触发。

## 3. 推荐表结构

### `app_settings`

用于保存全局运行参数。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `item_section` | TEXT | NOT NULL | 配置分组，如 `asr`、`llm`、`mail`、`system` |
| `item_mark` | TEXT | NOT NULL | 分组内唯一标识 |
| `item_title` | TEXT | NOT NULL | UI 展示标题 |
| `item_description` | TEXT | NOT NULL DEFAULT '' | 字段说明 |
| `item_value` | TEXT | NOT NULL | 标量或 JSON 字符串 |
| `updated_at` | TEXT | NOT NULL | ISO 时间 |

约束建议：

1. 以 `(item_section, item_mark)` 作为业务唯一键。
2. `item_section` 建议限制为 `asr`、`llm`、`mail`、`system`。
3. 敏感项如 `api_key`、`smtp_password` 在 API 返回时需要脱敏。

建议示例：

- `llm / base_url / LLM URL / 用于连接 LLM / http://host:port/v1`
- `llm / api_key / LLM API Key / 用于调用 LLM / sk-xxx`
- `llm / model / LLM Model / 当前使用模型 / qwen3.6-35b`
- `asr / provider / ASR Provider / 识别引擎类型 / local_funasr`
- `asr / endpoint / FunASR Endpoint / FunASR 服务地址 / ws://host:10095/ws`
- `mail / smtp_host / SMTP Host / 邮件服务主机 / smtp.example.com`
- `system / default_prompt_template_id / 默认纪要模板 / 自动生成首版结果时使用 / prompt-1`

### `users`

用于保存系统用户。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `account_name` | TEXT | NOT NULL | 账号名 |
| `display_name` | TEXT | NOT NULL | 显示名 |
| `email` | TEXT |  | 邮箱 |
| `department` | TEXT |  | 部门 |
| `external_user_id` | TEXT |  | 外部身份标识 |
| `status` | TEXT | NOT NULL | 用户状态 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |
| `updated_at` | TEXT | NOT NULL | ISO 时间 |

### `roles`

用于保存角色字典。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `role_key` | TEXT | NOT NULL UNIQUE | 角色代码 |
| `role_name` | TEXT | NOT NULL | 角色名称 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |

### `user_roles`

用于连接用户与角色。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `user_id` | TEXT | NOT NULL | 用户 ID |
| `role_id` | TEXT | NOT NULL | 角色 ID |
| `created_at` | TEXT | NOT NULL | ISO 时间 |

### `llm_prompt_templates`

用于保存 LLM 清洗模板。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `template_key` | TEXT | NOT NULL UNIQUE | 业务标识 |
| `template_name` | TEXT | NOT NULL | 模板名称 |
| `template_type` | TEXT | NOT NULL | `minutes` / `summary` / `actions` / `custom` |
| `content` | TEXT | NOT NULL | 模板正文 |
| `description` | TEXT | NOT NULL DEFAULT '' | 模板说明 |
| `status` | TEXT | NOT NULL | `active` / `disabled` |
| `is_system` | INTEGER | NOT NULL DEFAULT 0 | 是否系统预置 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |
| `updated_at` | TEXT | NOT NULL | ISO 时间 |

说明：

1. 模板由管理员维护，不对普通用户开放创建和编辑。
2. 被历史结果引用过的模板不应物理删除。

### `asr_hotwords`

用于保存管理员维护的 ASR 热词表。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `term` | TEXT | NOT NULL UNIQUE | 热词文本 |
| `weight` | INTEGER | NOT NULL | 热词权重 |
| `status` | TEXT | NOT NULL | `active` / `disabled` |
| `note` | TEXT | NOT NULL DEFAULT '' | 备注 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |
| `updated_at` | TEXT | NOT NULL | ISO 时间 |

说明：

1. 热词仅允许管理员维护。
2. 运行时只读取 `status = active` 的热词。
3. 代理层在 WebSocket 首帧中将热词表拼装为 `{"term": weight}` 形式的 JSON 字符串传给 FunASR。

### `meetings`

用于保存会议主记录。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `title` | TEXT | NOT NULL | 会议标题 |
| `source_type` | TEXT | NOT NULL | `live_recording` / `file_upload` |
| `source_file_name` | TEXT |  | 上传文件名 |
| `duration_seconds` | INTEGER |  | 时长 |
| `started_at` | TEXT |  | 会议开始时间 |
| `ended_at` | TEXT |  | 会议结束时间 |
| `status` | TEXT | NOT NULL | 会议自身状态 |
| `status_updated_at` | TEXT | NOT NULL | 状态更新时间 |
| `last_error_message` | TEXT |  | 最近一次失败信息 |
| `created_by_user_id` | TEXT | NOT NULL | 创建人 |
| `created_by_user_name` | TEXT | NOT NULL | 创建时用户名快照 |
| `created_by_user_email` | TEXT |  | 创建时用户邮箱快照 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |
| `updated_at` | TEXT | NOT NULL | ISO 时间 |

说明：

1. `meetings` 不直接保存原始 ASR 内容或 LLM 清洗正文。
2. `status` 只描述会议自身阶段，不承担某次 LLM 结果或发送记录的唯一真相源。

### `meeting_asr_results`

用于保存原始 ASR 结果。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `meeting_id` | TEXT | NOT NULL | 所属会议 |
| `asr_provider` | TEXT | NOT NULL | `dashscope` / `local_funasr` |
| `asr_setting_mark` | TEXT | NOT NULL | 使用的配置标识 |
| `asr_config_snapshot` | TEXT | NOT NULL | 使用的 ASR 配置快照 |
| `capture_session_id` | TEXT | NOT NULL | 代理侧采集会话 ID |
| `result_format` | TEXT | NOT NULL | `raw_events_json` 等 |
| `raw_payload` | TEXT | NOT NULL | 原始 JSON |
| `normalized_text` | TEXT | NOT NULL | 拼接后的纯文本 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |

说明：

1. `raw_payload` 保存代理采集到的完整上游事件集合或完整响应快照。
2. `capture_session_id` 用于把浏览器侧会议保存动作与代理侧原始采集结果关联起来。
3. `normalized_text` 是默认 LLM 清洗的标准输入来源。

### `meeting_llm_results`

用于保存 LLM 清洗结果版本。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `meeting_asr_result_id` | TEXT | NOT NULL | 来源 ASR 结果 |
| `llm_setting_mark` | TEXT | NOT NULL | 使用的 LLM 配置标识 |
| `prompt_template_id` | TEXT | NOT NULL | 使用的模板 |
| `generation_config_snapshot` | TEXT | NOT NULL | 生成时配置快照 |
| `generation_mode` | TEXT | NOT NULL | `default_auto` / `manual_regenerate` |
| `status` | TEXT | NOT NULL | `generating` / `succeeded` / `failed` |
| `version_no` | INTEGER | NOT NULL | 同一 ASR 结果内版本号 |
| `result_type` | TEXT | NOT NULL | `minutes` / `summary` / `actions` / `custom` |
| `result_title` | TEXT |  | 结果标题 |
| `raw_prompt` | TEXT | NOT NULL | 实际提示词快照 |
| `raw_response` | TEXT | NOT NULL | LLM 原始返回 |
| `result_markdown` | TEXT | NOT NULL | 最终正文 |
| `error_message` | TEXT |  | 失败信息 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |

说明：

1. 默认清洗和手动重生成都落在这张表。
2. `version_no` 在同一 `meeting_asr_result_id` 范围内递增。
3. 同一模板可以反复生成多版结果。

### `meeting_send_records`

用于保存邮件发送记录。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `meeting_llm_result_id` | TEXT | NOT NULL | 发送所用清洗结果 |
| `mail_template_type` | TEXT | NOT NULL | 邮件模板类型 |
| `subject` | TEXT | NOT NULL | 邮件主题 |
| `to_recipients_json` | TEXT | NOT NULL | 主送列表 |
| `cc_recipients_json` | TEXT | NOT NULL DEFAULT '[]' | 抄送列表 |
| `body_markdown` | TEXT | NOT NULL | Markdown 正文 |
| `body_html` | TEXT |  | HTML 正文 |
| `status` | TEXT | NOT NULL | `pending` / `sent` / `failed` |
| `mail_setting_mark` | TEXT | NOT NULL | 使用的邮件设置标识 |
| `mail_config_snapshot` | TEXT | NOT NULL | 邮件配置快照 |
| `provider_type` | TEXT |  | 邮件服务类型 |
| `provider_message_id` | TEXT |  | 服务消息 ID |
| `error_message` | TEXT |  | 失败信息 |
| `sent_by_user_id` | TEXT | NOT NULL | 发送人 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |
| `sent_at` | TEXT |  | 发送时间 |

说明：

1. 发送记录直接挂在 `meeting_llm_results` 下，不再单独保存 `meeting_id`。
2. 所属会议通过 `meeting_llm_result_id -> meeting_asr_result_id -> meeting_id` 回溯。

### `audit_logs`

用于保存审计日志。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | UUID |
| `actor_user_id` | TEXT | NOT NULL | 操作人 |
| `action_type` | TEXT | NOT NULL | 动作类型 |
| `resource_type` | TEXT | NOT NULL | 资源类型 |
| `resource_id` | TEXT | NOT NULL | 资源 ID |
| `request_id` | TEXT |  | 请求 ID |
| `result` | TEXT | NOT NULL | 结果 |
| `error_message` | TEXT |  | 错误信息 |
| `before_snapshot` | TEXT |  | 变更前快照 |
| `after_snapshot` | TEXT |  | 变更后快照 |
| `created_at` | TEXT | NOT NULL | ISO 时间 |

## 4. 最小索引建议

1. `app_settings(item_section, item_mark)`
2. `llm_prompt_templates(template_key)`
3. `asr_hotwords(term)`
4. `asr_hotwords(status)`
5. `meeting_asr_results(meeting_id)`
6. `meeting_asr_results(capture_session_id)`
7. `meeting_llm_results(meeting_asr_result_id, version_no)`
8. `meeting_llm_results(prompt_template_id)`
9. `meeting_send_records(meeting_llm_result_id)`

## 5. 一期不做的内容

1. 不做多用户隔离。
2. 不做密钥加密存储。
3. 不做复杂迁移框架，先用启动初始化脚本。
4. 不做全文检索，后续需要时再加 FTS。
5. 不做声纹注册和声纹库管理。

## 6. 与实现的直接对应关系

1. [src/app/admin/page.tsx](../../../src/app/admin/page.tsx) 对应 `app_settings`、`llm_prompt_templates`。
2. [src/app/page.tsx](../../../src/app/page.tsx) 对应 `meetings`、`meeting_asr_results`、`meeting_llm_results`。
3. [server/proxy.mjs](../../../server/proxy.mjs) 运行时读取 `app_settings` 中 `asr` 分组配置。
4. 后续会议清洗服务运行时读取 `app_settings` 中 `llm` 配置和 `llm_prompt_templates`。
