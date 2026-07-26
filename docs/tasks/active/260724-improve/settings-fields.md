# 260724 Improve - Settings Fields

## 1. 目标

把当前管理界面从静态原型整理为可持久化的配置页，并明确每个字段的存储含义与归属边界。

## 2. 配置与资源边界

当前后台管理页需要同时管理三类东西：

1. 系统配置
   落在 `app_settings`
2. LLM 清洗模板
   落在 `llm_prompt_templates`
3. ASR 热词表
   落在 `asr_hotwords`

这三类数据不能继续混在一张表里。

## 3. `app_settings` 统一设置表模型

### 配置模型

大多数系统配置统一落在 `app_settings` 中，一行表示一个配置项：

- `itemSection`
- `itemMark`
- `itemTitle`
- `itemDescription`
- `itemValue`

建议约束：

1. `(itemSection, itemMark)` 唯一。
2. `itemValue` 默认按字符串保存，复杂值允许 JSON。
3. 当前阶段只允许 `asr`、`llm`、`mail`、`system` 四类分组。

## 4. ASR 配置

### 建议字段项

- `asr / provider`
- `asr / endpoint`
- `asr / api_key`
- `asr / workspace_id`

### 字段说明

#### `provider`

可选值：

- `dashscope`
- `local_funasr`

#### `endpoint`

统一语义：

- `endpoint` 表示用户填写的服务根地址，不表示最终动作路径

具体规则：

- `local_funasr` 必填
- `dashscope` 可为空，运行时通过 `workspace_id` 派生上游地址

#### `api_key`

- `dashscope` 必填
- `local_funasr` 一期可选

#### `workspace_id`

- 仅 `dashscope` 使用

## 5. LLM 配置

### 建议字段项

- `llm / base_url`
- `llm / api_key`
- `llm / model`

### 字段说明

#### `base_url`

建议保存 OpenAI 兼容服务根地址，例如：

- `http://host:port/v1`
- `https://api.example.com/v1`

统一规则：

- `base_url` 不包含 `/chat/completions`
- 动作路径由服务端运行时补全

#### `model`

例如：

- `qwen3.6-35b`
- `gpt-4.1`
- `deepseek-chat`

## 6. 邮件配置

### 建议字段项

- `mail / smtp_host`
- `mail / smtp_port`
- `mail / smtp_username`
- `mail / smtp_password`
- `mail / smtp_secure`
- `mail / from_name`
- `mail / from_email`
- `mail / default_subject_template`
- `mail / default_signature`
- `mail / default_cc`

### 字段说明

#### `default_cc`

建议使用 JSON 数组字符串保存，例如：

```json
["a@example.com", "b@example.com"]
```

## 7. 系统配置

### 建议字段项

- `system / default_prompt_template_id`

### 字段说明

#### `default_prompt_template_id`

表示会议结束后自动生成首版 LLM 清洗结果时使用的模板主键。

它应指向 `llm_prompt_templates.id`，而不是模板标识字符串。

## 8. `llm_prompt_templates` 模板表

模板不再放在 `app_settings`。

后台需要管理模板列表，字段建议：

- `id`
- `templateKey`
- `templateName`
- `templateType`
- `content`
- `description`
- `status`
- `isSystem`

### 字段说明

#### `templateKey`

建议示例：

- `standard_minutes`
- `decision_log`
- `task_breakdown`
- `executive_summary`

#### `templateType`

建议枚举：

- `minutes`
- `summary`
- `actions`
- `custom`

#### 权限约束

1. 模板仅允许管理员维护。
2. 普通用户只负责选用模板，不负责创建和编辑模板。
3. 被历史结果引用过的模板不应物理删除，应通过 `status = disabled` 停用。

## 9. `asr_hotwords` 热词表

热词不放在 `app_settings`。

后台需要管理热词列表，字段建议：

- `id`
- `term`
- `weight`
- `status`
- `note`

### 字段说明

#### `term`

表示热词文本，例如：

- `阿里巴巴`
- `达摩院`
- `语音识别`

#### `weight`

建议使用整数权重，先从 `10`、`15`、`20` 这类值开始。

#### `status`

建议枚举：

- `active`
- `disabled`

#### 权限约束

1. 热词仅允许管理员维护。
2. 普通用户不负责创建和编辑热词。
3. 运行时只读取 `active` 热词。

## 10. 页面交互建议

### 后台整体布局

建议使用左侧导航或顶部 tabs，而不是把所有内容无限堆叠成单页卡片。

建议分区：

1. ASR 配置
2. LLM 配置
3. 邮件配置
4. 模板管理
5. 热词管理

### 保存方式

一期建议采用分区保存：

1. 系统配置按配置分区保存。
2. 模板列表独立管理和保存。
3. 热词列表独立管理和保存。

原因：

1. `app_settings`、`llm_prompt_templates`、`asr_hotwords` 已经是三类不同数据。
2. 混成一个整页 payload 会再次模糊边界。

### 当前生效项

建议不再设计“多套配置 + 激活切换”交互。

原因：

1. 一期目标是维护当前生效设置，而不是配置中心。
2. 保存模型会明显更简单。

### 测试方式

1. ASR 配置支持“测试连接”。
2. LLM 配置支持“测试 API”。
3. 邮件配置支持“测试发送”。
4. 测试请求可以不入库，只验证输入值是否有效。

测试区建议同时展示：

1. 当前测试状态。
2. 最近一次测试结果。
3. 失败原因。

### 模板管理区建议

建议至少支持：

1. 模板列表。
2. 模板名称、类型、状态展示。
3. 新增模板。
4. 编辑模板。
5. 停用模板。
6. 默认模板选择。

不建议继续使用“单个系统提示词 textarea”承载模板管理。

### 热词管理区建议

建议至少支持：

1. 热词列表。
2. 热词文本编辑。
3. 权重编辑。
4. 启用 / 停用。
5. 新增 / 删除。

不建议把热词做成主页面的本地编辑器。

## 11. 与现有页面的映射

当前页面 [src/app/admin/page.tsx](../../../src/app/admin/page.tsx) 需要从原型态改造成以下分区：

1. ASR 设置分区
2. LLM 设置分区
3. 邮件设置分区
4. 提示词模板列表、默认模板选择、模板编辑
5. 热词列表、权重编辑、启停控制
6. 统一保存或分区保存入口
