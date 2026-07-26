# 智能会议纪要 + 任务管理系统

基于 Next.js 的智能会议纪要系统，支持任务自动识别和管理。

## 功能特性

- 🎙 会议录音转写（FunASR）
- 📝 会议纪要自动生成（通义千问）
- 📋 任务自动识别（支持粘贴文本/上传Word）
- ✅ 任务全生命周期管理
- 📊 仪表盘统计
- 📥 Excel导出
- 🔔 邮件提醒（截止前3天/1天/当天）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

编辑 `.env.local` 文件，配置以下信息：

```env
# 阿里云 DashScope API Key
DASHSCOPE_API_KEY=your_api_key

# FunASR Workspace ID
FUNASR_WORKSPACE_ID=your_workspace_id

# 可选：自建 FunASR 服务地址，支持 http://host:10095 或 ws://host:10095/ws
FUNASR_SERVER_WS_URL=http://hp.inteva.vip:10095

# 邮件配置（SMTP）
EMAIL_HOST=smtp.qq.com
EMAIL_PORT=587
EMAIL_USER=your_email@qq.com
EMAIL_PASS=your_smtp_password
EMAIL_FROM=任务管理系统 <your_email@qq.com>
```

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

如果使用自建 FunASR 服务，代理会优先读取 `FUNASR_SERVER_WS_URL`，并自动将 `http://...:10095` 规范化为 `ws://...:10095/ws`。未配置该变量时，仍按原来的阿里云 DashScope 方式连接。

## 项目结构

```
src/
├── app/
│   ├── page.tsx                 # 主页（会议录音）
│   ├── tasks/
│   │   ├── page.tsx            # 任务列表
│   │   └── import/page.tsx     # 导入任务
│   ├── dashboard/
│   │   └── page.tsx            # 仪表盘统计
│   └── api/
│       └── tasks/
│           ├── route.ts        # 任务CRUD
│           ├── extract/route.ts # AI任务提取
│           └── export/route.ts  # Excel导出
├── lib/
│   ├── db.ts                   # SQLite数据库
│   ├── email.ts                # 邮件发送
│   └── scheduler.ts            # 定时任务
└── components/
    └── tasks/
        ├── TaskList.tsx        # 任务列表组件
        ├── TaskFilter.tsx      # 筛选组件
        ├── TaskImport.tsx      # 导入组件
        └── StatsCard.tsx       # 统计卡片
```

## 数据存储

使用 SQLite 数据库，数据文件保存在项目根目录的 `data.db` 文件中。

## 邮件配置说明

### QQ邮箱配置

1. 登录QQ邮箱 -> 设置 -> 账户
2. 开启 SMTP 服务
3. 生成授权码
4. 配置到 `.env.local`

### 163邮箱配置

1. 登录163邮箱 -> 设置 -> POP3/SMTP/IMAP
2. 开启 SMTP 服务
3. 设置授权码
4. 配置到 `.env.local`
