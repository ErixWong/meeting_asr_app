# 260724 Improve - Mail Delivery Design

## 1. 目标

定义会议结果邮件发送能力，包括配置、发送流程、模板、发送记录、失败处理和一期建议范围。

## 2. 产品定位

邮件发送不是附属按钮，而是会议纪要系统的正式输出通道。

目标是：

1. 用户完成结果确认后，可以选择收件人并发送。
2. 系统保留完整发送记录，便于追溯和重发。
3. 后台可以管理邮件服务配置。

## 3. 一期产品原则

1. 默认不自动发送，先人工确认后发送。
2. 支持主送、抄送，可暂不做密送。
3. 支持单次发送记录留痕。
4. 发送失败后允许重试。
5. 邮件正文基于当前选定的 LLM 清洗结果生成。

## 4. 发送主流程

建议流程：

1. 用户进入会议详情页。
2. 选择一条 `meeting_llm_result`。
3. 填写或确认收件人。
4. 预览邮件主题和正文。
5. 点击发送。
6. 系统调用邮件服务发送。
7. 系统保存 `meeting_send_records`。
8. 根据结果更新会议状态。

## 5. 收件人设计

### 收件人类型

建议一期支持：

1. To
2. Cc

二期再考虑：

1. Bcc
2. 收件人分组

### 收件人来源

建议支持以下来源：

1. 手工输入邮箱。
2. 从历史会议复用。

后续可扩展：

1. 企业通讯录选择。
2. 角色组或部门组。

## 6. 邮件模板设计

建议分两层：

1. 邮件壳模板
2. LLM 清洗结果正文

### 邮件壳模板

控制：

- 邮件主题
- 开场语
- 结尾签名
- 公司固定说明

### 正文内容来源

来源于：

- 当前发送所选 `meeting_llm_results.result_markdown`

建议支持的邮件模板类型：

1. `formal_minutes_mail`
2. `brief_sync_mail`
3. `decision_confirmation_mail`
4. `action_followup_mail`

## 7. 邮件设置项建议

后台建议至少支持以下配置：

1. SMTP Host
2. SMTP Port
3. SMTP Username
4. SMTP Password
5. SMTP Secure
6. 发件人名称
7. 发件人邮箱
8. 默认邮件主题模板
9. 默认邮件签名
10. 默认抄送

说明：

1. 一期可先基于 SMTP。
2. 后续如需企业网关，可在接口层扩展而不影响 UI。
3. 邮件配置建议继续落在 `app_settings` 的 `mail` 分组。

## 8. 邮件主题建议

建议支持变量模板，例如：

`[会议纪要] {meetingTitle} - {meetingDate}`

建议变量：

- `{meetingTitle}`
- `{meetingDate}`
- `{creator}`
- `{resultVersion}`

## 9. 发送记录设计

建议使用 `meeting_send_records` 表。

建议字段：

- `id`
- `meeting_llm_result_id`
- `mail_template_type`
- `subject`
- `to_recipients_json`
- `cc_recipients_json`
- `body_markdown`
- `body_html`
- `status`
- `provider_type`
- `provider_message_id`
- `error_message`
- `sent_by_user_id`
- `created_at`
- `sent_at`

说明：

1. 发送前可先写一条 `pending` 记录。
2. 成功后更新为 `sent`。
3. 失败后更新为 `failed`。
4. 所属会议通过 `meeting_llm_result_id -> meeting_asr_result_id -> meeting_id` 回溯。

## 10. 会议状态与邮件状态关系

建议规则：

1. 会议结果可发送前，会议应处于 `pending_review`。
2. 发送中时，会议状态可临时进入 `sending`。
3. 发送成功后，会议进入 `sent`。
4. 发送失败后，会议进入 `send_failed`。

## 11. 失败处理建议

至少处理以下场景：

1. SMTP 配置缺失。
2. SMTP 认证失败。
3. 收件人地址不合法。
4. 网络超时。
5. 邮件服务拒绝发送。

失败后建议行为：

1. 保留用户填写的收件人信息。
2. 保留预览内容。
3. 展示失败原因。
4. 允许修正后重试。

## 12. API 建议补充

建议在 [API 设计](./api-design.md) 基础上增加：

### `POST /api/meetings/:id/send-mail`

请求建议：

```json
{
  "meetingLlmResultId": "result-2",
  "mailTemplateType": "formal_minutes_mail",
  "subject": "[会议纪要] 项目例会 - 2026-07-24",
  "toRecipients": ["a@example.com"],
  "ccRecipients": ["b@example.com"]
}
```

响应建议：

```json
{
  "sendRecord": {
    "id": "send-1",
    "status": "sent"
  }
}
```

### `GET /api/meetings/:id/send-records`

返回邮件发送历史。

### `GET /api/admin/settings`

返回后台邮件设置。

### `POST /api/admin/settings`

保存后台邮件设置。

### `POST /api/admin/test-mail`

测试邮件发送能力。

## 13. UI 建议

### 会议详情页

建议提供：

1. 收件人编辑区。
2. 邮件主题输入框。
3. 邮件预览。
4. 发送按钮。
5. 历史发送记录列表。

### 管理后台

建议提供：

1. SMTP 配置表单。
2. 发件人信息。
3. 默认邮件主题与签名配置。
4. 测试发送入口。

## 14. 一期边界

一期建议不做：

1. 自动发送。
2. 定时发送。
3. 企业通讯录集成。
4. 外部邮件审批流。
5. 邮件已读回执。

## 15. 与现有文档的关系

1. [产品改进计划](./product-improvement-plan.md)
   这里落实其中“邮件发送配置”和“发送记录”要求。
2. [数据库设计](./schema-design.md)
   这里的发送记录对应 `meeting_send_records`。
3. [设置界面字段设计](./settings-fields.md)
   这里的邮件配置字段落在 `app_settings.mail`。
4. [会议状态机](./meeting-lifecycle.md)
   这里的发送状态需要与会议状态联动。
