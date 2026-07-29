# 智能会议纪要系统

基于 Next.js 的智能会议纪要系统，支持会议录音转写、会议纪要生成、邮件发送和后台配置管理�?
## 功能特�?
- 会议录音转写（FunASR�?- 会议纪要自动生成（LLM�?- 历史会议记录管理
- ASR Gateway 统一承接前端 WebSocket 连接和敏感配�?- 后台配置管理（ASR、LLM、邮件、提示词模板、热词、用户与权限�?- 邮件发送记录和审计日志

> 任务/行动项跟踪不属于当前产品范围。如后续需要，应作为独立产品开发，并消费本系统输出的转写文本或会议纪要�?
## 快速开�?
### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发服�?
```bash
npm run dev
```

`npm run dev` 会同时启动：

- `server/asr-gateway.mjs`
- `next dev`

访问 http://localhost:3123

### 3. 配置

敏感配置通过后台管理页保存到本地 SQLite，不应直接放到前端代码中�?
- ASR 服务地址、Workspace ID、API Key
- LLM Base URL、API Key、模�?- SMTP 邮件配置
- 默认提示词模板和热词

## 项目结构

```text
src/
├── app/
�?  ├── page.tsx                 # 主页面：录音、历史会议、转写和纪要
�?  ├── admin/
�?  �?  └── page.tsx             # 管理后台
�?  └── api/
�?      ├── config/              # 运行配置读取
�?      ├── meetings/            # 会议、ASR、LLM、邮件发送记�?�?      ├── summarize/           # 兼容纪要生成接口
�?      └── admin/               # 后台配置、用户、角色、审�?├── components/
�?  └── main/                    # 录音控件、历史列表、转写视�?├── lib/
�?  ├── admin-store.ts           # SQLite 存储、配置、会议、审计、极简 RBAC
�?  ├── api-auth.ts              # 后台 API 角色守卫
�?  ├── funasr.ts                # 浏览器端 ASR 客户�?�?  ├── store-utils.ts           # 通用存储工具
�?  └── voiceprint.ts            # 声纹特征提取与聚�?└── types/
    └── index.ts                 # 类型定义

server/
├── asr-gateway.mjs              # ASR Gateway
└── runtime-store.mjs            # Gateway 读取运行配置
```

## 数据存储

本地 SQLite 数据库文件位于：

```text
data/meeting-asr-app.db
```

## 说明

当前项目重点是会议纪要主链路�?
```text
录音/上传 -> ASR Gateway -> FunASR -> 转写结果 -> LLM 纪要 -> 邮件发�?```

任务管理、行动项跟踪、提醒调度不在当前产品范围内�?
