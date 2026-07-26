# 260724 Improve - API Design

## 1. 目标

为配置管理、模板管理、会议持久化、LLM 清洗与邮件发送提供最小可用 API。

## 2. 设计原则

1. 先服务当前单机应用，不做复杂鉴权。
2. API 与页面状态解耦，前端不直接管理核心业务数据。
3. 会议保存、LLM 清洗、邮件发送按事实链路拆开，不做大一统提交。
4. 模板是独立资源，配置和模板不混用同一套接口结构。

## 3. 配置、模板与热词相关 API

### `GET /api/config`

返回当前运行期配置摘要，用于主页面录音前检查。

响应建议：

```json
{
  "asr": {
    "providerType": "local_funasr",
    "endpoint": "ws://host:10095/ws",
    "hasApiKey": false,
    "hasWorkspaceId": false
  },
  "llm": {
    "baseUrl": "http://host:port/v1",
    "model": "qwen3.6-35b",
    "hasApiKey": true
  },
  "defaultPromptTemplate": {
    "id": "prompt-1",
    "templateKey": "standard_minutes",
    "templateType": "minutes",
    "name": "标准会议纪要"
  }
}
```

说明：

1. 不直接把完整密钥明文返回给前端。
2. 主页面只需要知道是否可用以及当前启用项。
3. `baseUrl` 字段统一表示“用户填写的服务根地址”，不是最终动作路径。

### `GET /api/admin/settings`

返回后台系统配置。

响应建议：

```json
{
  "settings": []
}
```

### `POST /api/admin/settings`

保存后台系统配置。

请求建议：

```json
{
  "settings": []
}
```

说明：

1. 该接口只负责 `app_settings`。
2. 模板管理走独立模板接口。

### `GET /api/admin/prompt-templates`

返回模板列表。

### `POST /api/admin/prompt-templates`

创建模板。

请求建议：

```json
{
  "templateKey": "standard_minutes",
  "templateName": "标准会议纪要",
  "templateType": "minutes",
  "content": "...",
  "description": "适用于常规项目会议"
}
```

### `PATCH /api/admin/prompt-templates/:id`

更新模板。

### `POST /api/admin/prompt-templates/:id/disable`

停用模板。

说明：

1. 模板仅允许管理员维护。
2. 被历史 `meeting_llm_results` 引用过的模板不应物理删除。

### `POST /api/admin/test-asr`

测试当前某条 ASR 配置是否可连通。

请求建议：

```json
{
  "providerType": "local_funasr",
  "endpoint": "http://host:10095",
  "apiKey": "",
  "workspaceId": ""
}
```

### `POST /api/admin/test-llm`

测试当前某条 LLM 配置是否可调用。

请求建议：

```json
{
  "baseUrl": "http://host:port/v1",
  "apiKey": "sk-xxx",
  "model": "qwen3.6-35b"
}
```

### `POST /api/admin/test-mail`

测试当前邮件配置是否可发送。

### `GET /api/admin/hotwords`

返回热词表列表。

响应建议：

```json
{
  "hotwords": [
    {
      "id": "hotword-1",
      "term": "阿里巴巴",
      "weight": 20,
      "status": "active",
      "note": "公司名称"
    }
  ]
}
```

### `POST /api/admin/hotwords`

创建热词。

请求建议：

```json
{
  "term": "达摩院",
  "weight": 15,
  "note": "组织名"
}
```

### `PATCH /api/admin/hotwords/:id`

更新热词内容、权重或状态。

请求建议：

```json
{
  "term": "语音识别",
  "weight": 10,
  "status": "active",
  "note": "领域词"
}
```

### `POST /api/admin/hotwords/:id/disable`

停用热词。

### `DELETE /api/admin/hotwords/:id`

删除未使用或无历史依赖的热词。

说明：

1. 热词仅允许管理员维护。
2. 运行时只拼装 `status = active` 的热词。
3. 代理在 WebSocket 首帧中将热词表转换成 FunASR 要求的 `hotwords` JSON 字符串。

## 4. 会议相关 API

### `GET /api/meetings`

返回会议列表。

响应建议字段：

- `id`
- `title`
- `status`
- `startedAt`
- `endedAt`
- `durationSeconds`
- `sourceType`
- `latestResultPreview`

### `GET /api/meetings/:id`

返回会议详情。

响应建议包含：

- `meeting`
- `asrResult`
- `llmResults`
- `sendRecords`

说明：

1. 不一定每次都把完整 `raw_payload` 返回给前端。
2. 原始 ASR 可单独通过专门接口查看。

### `POST /api/meetings`

保存新会议事实记录。

请求建议：

```json
{
  "title": "项目例会",
  "sourceType": "live_recording",
  "durationSeconds": 1234,
  "sourceFileName": null,
  "captureSessionId": "capture-20260724-001"
}
```

处理建议：

1. 保存会议主记录。
2. 根据 `captureSessionId` 读取代理侧临时采集结果。
3. 保存原始 ASR 结果。
4. 事务提交后，再根据系统设置决定是否触发默认 LLM 清洗。

设计原则：

1. `POST /api/meetings` 负责提交“会议已完成转写”这一事实。
2. 默认 LLM 清洗不是这次提交的一部分事务回滚条件。
3. 即使默认清洗失败，会议和原始 ASR 结果也必须保留。

响应建议：

```json
{
  "meeting": {
    "id": "meeting-1",
    "status": "transcribed"
  },
  "defaultLlmResult": {
    "triggered": true,
    "status": "pending"
  }
}
```

### `PATCH /api/meetings/:id`

用于修改会议标题或会议自身状态。

请求建议：

```json
{
  "title": "新标题",
  "status": "archived"
}
```

### `DELETE /api/meetings/:id`

删除会议及关联 ASR 结果、LLM 结果、发送记录。

## 5. LLM 清洗相关 API

### `POST /api/meetings/:id/llm-results`

为指定会议生成一条新的 LLM 清洗结果。

请求建议：

```json
{
  "promptTemplateId": "prompt-2",
  "generationMode": "manual_regenerate"
}
```

处理建议：

1. 读取会议对应主 `meeting_asr_result` 的 `normalized_text`。
2. 读取指定模板；未传则取当前默认模板。
3. 读取当前激活 LLM 配置。
4. 调用 OpenAI 兼容接口。
5. 保存 `meeting_llm_results` 新版本。

说明：

1. 默认自动清洗与手动重解析都复用这一条业务能力。
2. 区别只在于 `generationMode`、触发时机和是否由系统自动调用。

响应建议：

```json
{
  "llmResult": {
    "id": "result-3",
    "versionNo": 3,
    "generationMode": "manual_regenerate",
    "resultMarkdown": "# ..."
  }
}
```

### `GET /api/meetings/:id/llm-results`

返回指定会议的 LLM 清洗结果列表。

### `GET /api/meetings/:id/llm-results/:resultId`

返回单个 LLM 清洗结果详情。

建议包含：

- `resultMarkdown`
- `templateInfo`
- `llmInfo`
- `createdAt`

## 6. 邮件发送相关 API

### `POST /api/meetings/:id/send-mail`

基于指定 LLM 清洗结果发送邮件。

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

## 7. 原始结果查看 API

### `GET /api/meetings/:id/asr-results`

返回 ASR 结果元数据列表。

### `GET /api/meetings/:id/asr-results/:resultId`

返回某次 ASR 原始 payload 详情。

说明：

1. 这个接口主要服务排障和内部查看。
2. UI 可先不开放，API 先预留。

## 8. 与现有代码的替换关系

1. [src/app/api/config/route.ts](../../../src/app/api/config/route.ts) 改为从数据库读取当前激活配置和默认模板摘要。
2. [src/app/api/summarize/route.ts](../../../src/app/api/summarize/route.ts) 可收敛为清洗服务内部逻辑，外部入口改成 `POST /api/meetings/:id/llm-results`。
3. [src/app/page.tsx](../../../src/app/page.tsx) 停止直接维护完整 `meetings` 内存真相源，改为通过 API 加载和保存。
4. [src/app/admin/page.tsx](../../../src/app/admin/page.tsx) 改为分别通过设置接口和模板接口读写。

## 9. 一期最小实现顺序

1. `GET /api/admin/settings`
2. `POST /api/admin/settings`
3. `GET /api/admin/prompt-templates`
4. `POST /api/admin/prompt-templates`
5. `GET /api/config`
6. `GET /api/meetings`
7. `POST /api/meetings`
8. `GET /api/meetings/:id`
9. `POST /api/meetings/:id/llm-results`
10. `POST /api/meetings/:id/send-mail`
