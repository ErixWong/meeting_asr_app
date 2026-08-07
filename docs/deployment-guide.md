# 容器部署指南

> 部署模型：**官方 `node:24-slim` 基座 + 源码目录 bind mount**，不构建自定义镜像。

## 1. 部署模型

```text
宿主机 (Linux / Windows Docker Desktop)
└── <项目目录>/                      # 源码（bind mount 到容器 /app）
    ├── docker-compose.yml
    ├── .env                         # 部署配置
    └── .docker/                     # 运行产物与数据（bind mount，独立目录）
        ├── node_modules/            # 容器内 npm ci 安装的 Linux 平台依赖
        ├── .next/                   # 容器内 next build 的产物
        └── data/                    # SQLite 数据库 meeting-asr-app.db
```

关键设计：

- **基座**：`node:24-slim`（Debian bookworm / glibc），满足 `node:sqlite` 内置模块（Node ≥ 23.4 免 flag）、`sharp@0.35.3` 与 `@next/swc-linux-x64-gnu` 的预编译二进制，无需编译工具链。
- **运行产物隔离**：宿主机开发机（如 Windows）的 `node_modules` / `.next` 是平台相关二进制，不能直接给 Linux 容器用。compose 将容器内 `/app/node_modules`、`/app/.next` 分别挂到宿主机 `.docker/` 下独立目录，首次启动由容器内 `npm ci` / `npm run build` 生成 Linux 版本，同时不污染源码目录。
- **数据持久化**：SQLite 位于 `process.cwd()/data`，即容器内 `/app/data` → 宿主机 `.docker/data`。

## 2. 前置条件

- Docker Engine + Compose v2（`docker compose version` 可运行）
- 部署机建议 Linux x86_64（Windows/macOS 需 Docker Desktop，构建性能更慢）
- 已开放的端口：`3123`

## 3. 部署步骤

### 3.1 拷贝源码到宿主机

将项目源码拷贝到部署机（**排除运行产物**，减少拷贝量与平台冲突）：

```bash
rsync -av --exclude node_modules --exclude .next --exclude data --exclude .docker /path/to/source/ user@server:/opt/meeting-asr-app/
```

Windows 开发机可直接拷贝整个目录，但请勿携带 `node_modules`、`.next`、`data`（拷贝后删除亦可）；这些目录会被 `.docker/` 挂载遮罩，不影响容器运行。

### 3.2 确认目录结构

```bash
cd /opt/meeting-asr-app
ls docker-compose.yml          # 部署清单
mkdir -p .docker/node_modules .docker/.next .docker/data
```

### 3.3 配置 .env

```bash
cat > .env <<'EOF'
# 线上访问的 Origin（浏览器地址栏的协议+域名+端口，多个用逗号分隔）
# 不配置时 WebSocket (/asr) 握手会被 Origin 白名单拒绝
ASR_GATEWAY_ALLOWED_ORIGINS=https://meeting.example.com
# 直接使用 http://host:3123 时设为 false；HTTPS 反向代理时设为 true
AUTH_COOKIE_SECURE=false
# 引导管理员（首次启动创建）
BOOTSTRAP_ADMIN_ACCOUNT=admin
BOOTSTRAP_ADMIN_PASSWORD=<强密码，勿用默认值>
EOF
```

> 应用业务配置（ASR/LLM/SMTP/模板等）不在 .env 中，通过后台管理页面保存到 SQLite，首次部署后需在 `http://<host>:3123/admin` 完成初始化配置。

### 3.4 启动

```bash
docker compose up -d
docker compose ps            # 状态应为 running (healthy)
```

- 首次启动较慢（容器内 `npm ci` + `npm run build`，视网络与磁盘 2~5 分钟），健康检查 `start_period` 已按 180s 配置。
- 启动命令为条件式：`node_modules/next/package.json` 存在则跳过安装，`.next/BUILD_ID` 存在则跳过构建，之后直接启动应用。这样即使 Docker 自动创建了空的 `.docker/node_modules` 挂载目录，也会正常执行 `npm ci`。

### 3.5 验证

```bash
docker compose logs -f app              # 观察 "Production server running on http://0.0.0.0:3123"
curl -sI http://127.0.0.1:3123/login    # 期望 HTTP 200
docker compose exec app node -e "fetch('http://127.0.0.1:3123/login').then(r=>console.log(r.status))"
```

浏览器访问 `http://<host>:3123`，使用引导管理员登录，进入 `/admin` 配置 ASR / LLM / SMTP。

## 4. 代码更新

源码为 bind mount，代码改动即时可见，但 `.next` 是旧构建，需重建后重启：

```bash
docker compose exec app npm run build
docker compose restart app
```

> 重建期间服务短暂不可用；`.docker/data` 中的数据库不受影响。

## 5. 数据备份与恢复

数据库为单文件 `meeting-asr-app.db`，备份即拷贝文件：

```bash
# 备份（建议先停止写入或直接用 sqlite 在线备份）
cp -a .docker/data/meeting-asr-app.db backup-$(date +%F).db

# 恢复
cp backup-xxx.db .docker/data/meeting-asr-app.db
docker compose restart app
```

## 6. 安全注意事项

- **必须**设置 `BOOTSTRAP_ADMIN_PASSWORD`，默认 `admin123` 仅限开发。
- **必须**将 `ASR_GATEWAY_ALLOWED_ORIGINS` 配置为实际访问 Origin，否则 WebSocket 握手被拒（生产默认拒绝未认证连接）。
- 如果通过 HTTPS 反向代理访问，将 `AUTH_COOKIE_SECURE` 设为 `true`；如果直接通过 HTTP 访问 3123 端口，保持为 `false`，否则浏览器不会发送登录 cookie。
- 当前容器以 root 运行；如需加固，可在 compose 增加 `user: "node"` 并对 `.docker/` 目录 `chown -R node:node`。
- 敏感配置（ASR/LLM/SMTP 密钥）存于 SQLite，注意 `.docker/data` 的访问权限。

## 7. 常见问题

| 现象 | 原因与处理 |
|:---|:---|
| 容器反复重启 / healthcheck 不通过 | 首次构建未完成，查看 `docker compose logs app`；确认网络可访问 npm registry |
| 页面能打开，但录音/转写 WebSocket 失败 | `ASR_GATEWAY_ALLOWED_ORIGINS` 未包含实际 Origin |
| 修改代码后不生效 | 未重建 `.next`，执行 `docker compose exec app npm run build && docker compose restart app` |
| 需要彻底重置（重装依赖 + 重新构建） | `docker compose down` 后清空 `.docker/node_modules` 与 `.docker/.next` 再 `up -d` |
| 换部署机迁移 | 源码 + `.env` + `.docker/data`（数据库）三者一并迁移即可 |
