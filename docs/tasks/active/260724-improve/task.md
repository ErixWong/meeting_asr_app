# 260724 Improve

## 文档索引

本任务已拆分为以下子文档：

1. [数据库设计](./schema-design.md)
2. [API 设计](./api-design.md)
3. [提示词模板](./prompt-templates.md)
4. [设置界面字段设计](./settings-fields.md)
5. [产品改进计划](./product-improvement-plan.md)
6. [会议状态机](./meeting-lifecycle.md)
7. [邮件发送设计](./mail-delivery-design.md)
8. [声纹录入设计](./speaker-enrollment-design.md)
9. [后端运行时设计](./backend-runtime.md)
10. [权限与审计设计](./permission-and-audit.md)
11. [数据模型设计](./data-model.md)

## 1. 目标

基于当前原型实现，补齐本地可用的持久化与配置管理能力，使系统从“前端内存态演示”升级为“可保存配置、可保存会议结果、可切换 ASR/LLM 后端”的单机版应用。

本任务覆盖以下方向：

1. 创建 SQLite 数据库并承载核心业务数据。
2. 配置界面的保存改为数据库持久化，不再依赖 `.env.local` 作为运行期配置来源。
3. FunASR 支持两种类型：阿里云 DashScope 和本地 FunASR。
4. LLM 改为 OpenAI 兼容接口配置方式。
5. LLM 清洗模板改为可配置、可持久化。
6. 保存会议事实，且同时保存原始 ASR 结果、LLM 清洗结果和发送记录。

## 2. 当前结论摘要

当前这组设计文档已经收敛到以下基线：

1. 系统配置统一落在 `app_settings`。
2. LLM 清洗模板独立落在 `llm_prompt_templates`，仅允许管理员维护。
3. 会议主链为：

`meetings -> meeting_asr_results -> meeting_llm_results -> meeting_send_records`

4. 会议保存与默认 LLM 清洗采用 post-commit 解耦。
5. 原始 ASR 由代理采集，业务 API 负责最终落库。
6. 声纹注册与声纹库管理不纳入本轮主模型。

## 3. 文档职责约定

为避免重复真相源，后续阅读和修改请遵循以下分工：

1. `data-model.md`
   负责业务实体、关系链、真相源和边界。
2. `schema-design.md`
   负责 SQLite 表结构、字段、约束和索引。
3. `settings-fields.md`
   负责后台配置字段和模板管理边界。
4. `api-design.md`
   负责接口契约。
5. `meeting-lifecycle.md`
   负责状态定义、流转和页面行为。
6. `mail-delivery-design.md`
   负责邮件域流程与发送记录语义。
7. `backend-runtime.md`
   负责运行时职责、配置生效机制和代理边界。
8. `prompt-templates.md`
   负责模板内容与模板资源规则。

## 4. 当前实现优先级

建议按以下顺序推进实现：

1. 落库 `app_settings`、`llm_prompt_templates`、会议主链表。
2. 打通后台配置与模板管理接口。
3. 打通会议保存与原始 ASR 落库。
4. 打通默认 LLM 清洗与手动重生成。
5. 打通邮件发送与发送记录。
