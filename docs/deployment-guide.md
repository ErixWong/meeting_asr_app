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

# —— 数据库：当前只支持 SQLite（零配置），无需任何配置 ——
# ⚠ 下面的 DB_TYPE=mysql|mssql 是「进行中能力」，生产**暂不可用**，见 3.3.1。
# DB_TYPE=sqlite         # 唯一支持值（默认）；mysql / mssql 尚未接线
# DB_HOST=10.0.0.5       # （未来）外部实例地址
# DB_PORT=3306           # （未来）MySQL 默认 3306；MSSQL 默认 1433
# DB_NAME=meeting_asr    # （未来）实例上需先创建同名数据库/库
# DB_USER=meeting_app
# DB_PASSWORD=<数据库密码>
# DB_ENCRYPT=false       # （未来）MSSQL 启用 TLS 时设 true
EOF
```

> 应用业务配置（ASR/LLM/SMTP/模板等）不在 .env 中，通过后台管理页面保存到数据库，首次部署后需在 `http://<host>:3123/admin` 完成初始化配置。

### 3.3.1 数据库支持面（当前真实状态）

**生产目前仅 SQLite 经过真机验证。** `DB_TYPE=mysql|mssql` 是进行中能力（见 issue #53/#54/#55 的阶段计划），现在**配了也不会生效**：

- 运行时（`server/db-shared.mjs` 的 `getDb()`）仍写死 `node:sqlite`，**不读 `DB_TYPE`**；把 `DB_TYPE` 接到运行时是阶段②（#54）的工作。
- knex 三方言基建（`server/db/index.mjs` / `async-db.mjs` / `schema.mjs`）已存在并已通过三库测试，但目前只被 `scripts/*` 调用，不在运行时路径上。
- SQLite 是单文件数据库（`data/meeting-asr-app.db`），备份/迁移/换机都只需拷文件（见 §6）。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| ① #53 | 方言事实钉死 + 三库测试脚手架（零运行时变更） | 已完成 |
| ② #54 | 114 处裸 SQL 同步→异步、`getKnex()` 成为唯一入口、`DB_TYPE` 真正生效 | 待做 |
| ③ #55 | 方言语法清零（`ON CONFLICT` / `INSERT OR IGNORE` / `PRAGMA`）+ 大小写语义落地 + 三库 CI | 待做 |

> 方言事实与待办清单：`docs/design/db-dialect-portability.md`。

### 3.3.2 外部实例连通性冒烟（当前只用于验证基建，不影响运行时）

```bash
# SQLite（默认，零配置）
node scripts/db-smoke.mjs

# 外部实例（仅冒烟 knex 基建，不会改变应用运行时的数据库）
DB_TYPE=mysql DB_HOST=10.0.0.5 DB_PORT=3306 DB_NAME=meeting_asr DB_USER=... DB_PASSWORD=... \
  node scripts/db-smoke.mjs
DB_TYPE=mssql DB_HOST=10.0.0.5 DB_PORT=1433 DB_NAME=meeting_asr DB_USER=sa DB_PASSWORD=... \
  node scripts/db-smoke.mjs
```

> ⚠ `scripts/db-smoke.mjs` 会在目标库里建/删一张 `__smoke_test__` 临时表——**只对专用测试库跑**，不要指向生产实例。
> 三库 schema/迁移与语义锁的完整矩阵：`npm run db:test-parity`（见 `docs/design/db-dialect-portability.md` §6）。

### 3.4 启动

```bash
docker compose up -d
docker compose ps            # 状态应为 running (healthy)
```

- 首次启动较慢（容器内 `npm ci` + `npm run build`，视网络与磁盘 2~5 分钟），健康检查 `start_period` 已按 180s 配置。
- 启动命令为条件式：`node_modules/next/package.json` 存在则跳过安装；`.next/BUILD_ID` 存在且源码（`src/`、`server/`、`public/` 及构建相关配置）不比构建产物新，则跳过构建，之后直接启动应用。这样 Docker 自动创建的挂载目录会正常执行 `npm ci` / 首次构建；`git pull` 更新源码后重启容器即可自动重建，无需手动执行构建。

### 3.5 验证

```bash
docker compose logs -f app              # 观察 "Production server running on http://0.0.0.0:3123"
curl -sI http://127.0.0.1:3123/login    # 期望 HTTP 200
docker compose exec app node -e "fetch('http://127.0.0.1:3123/login').then(r=>console.log(r.status))"
```

浏览器访问 `http://<host>:3123`，使用引导管理员登录，进入 `/admin` 配置 ASR / LLM / SMTP。

### 3.6 声纹识别服务（可选）

需要说话人识别（转写显示人名）时，额外部署声纹独立容器：

```bash
cd deploy/voiceprint && docker compose up -d
curl http://127.0.0.1:10097/health   # 期望 modelLoaded:true
```

- 前置：与 ASR 共享镜像与模型（`funasr-runtime-sdk` 镜像 + CAM++ 16k 模型），部署 ASR 后即有
- 配置：admin 后台「声纹管理」tab（端点默认 `http://127.0.0.1:10097`、阈值 0.35、启停开关）
- **双容器双模型**：中文版（10097）+ 中英双语版（10098，英文会议），「识别模型」下拉切换，两库独立
- 降级：声纹服务不可用时主应用自动回退前端启发式聚类，录音主流程不受影响
- 完整部署/运维/备份说明：见 [funasr-voiceprint-deployment.md](funasr-voiceprint-deployment.md)

### 3.7 TTS 语音合成服务（可选）

对话页的「语音回复」由主应用内置的 TTS 网关（`server/tts-gateway.mjs`）提供：对前端暴露 `/api/tts/health`、`/api/tts/voices`、`/api/tts/synthesize`（SSE 流式），同时对外提供 OpenAI 兼容的 `POST /v1/audio/speech`。上游可以是本地 CosyVoice 容器，也可以是任意 OpenAI 兼容 TTS 服务。

- **端口**：CosyVoice 容器默认 `8010`（`/inference_sft` 合成、`/voices` 音色列表、`/health` 探活）；容器内访问宿主机上的服务一律用 `host.docker.internal`（compose 已配 `extra_hosts: host.docker.internal:host-gateway`，把宿主网关 IP 注入容器；没有它容器里的 `host.docker.internal` 无法解析）。
- **配置位置**：后台 `/admin` →「TTS 配置」页，保存进数据库 `app_settings` 的 `tts:*` 段。

| 环境变量 | 对应 DB 设置 | 说明 |
|:---|:---|:---|
| `TTS_ENDPOINT` | `tts:endpoint` | 服务地址。cosyvoice：容器地址（如 `http://host.docker.internal:8010`）；openai：**服务根地址**（如 `https://api.openai.com`，**不要带 `/v1`**，网关自动拼 `/v1/audio/speech`；历史配置里带 `/v1` 的值会被自动规范化掉） |
| `TTS_PROVIDER` | `tts:provider` | `cosyvoice`（默认）/ `openai` |
| `TTS_MODEL` | `tts:model` | openai 协议的模型名（如 `tts-1` / `gpt-4o-mini-tts`），cosyvoice 协议下忽略 |
| `TTS_API_KEY` | `tts:api_key` | openai 协议的鉴权 key，以 `Authorization: Bearer` 发送；免鉴权的兼容服务留空即可 |

- **优先级**：环境变量**非空则压过数据库**；环境变量为空串或未设置时用数据库值，再兜底内置默认值（`http://localhost:8010` / `cosyvoice` / `tts-1`）。compose 里这四个变量默认都是空串（`${TTS_ENDPOINT:-}`），所以默认行为是**以后台配置为准**；只有在确实要锁死配置时才在 `.env` 里给它们赋值。
  - ⚠ 若这里给了非空默认值（例如 `TTS_ENDPOINT: ${TTS_ENDPOINT:-http://host.docker.internal:8011}`），env 会永久压住数据库值，表现为「后台改了地址不生效」。
- **生效延迟**：网关对配置做 10 秒缓存（`CONFIG_TTL_MS`），后台保存后约 10 秒生效，**无需重启容器**。
- **两种协议的差异**：
  - `cosyvoice`（私有协议）：按标点逐句合成（降低首音延迟），并**按回复语言自动切换音色**（zh / yue / en / ja / ko；容器没有该音色时回退默认音色）；音色下拉从容器 `/voices` 实时拉取。
  - `openai`（标准协议）：整段一次合成（标准协议无逐句/多音色语义），音色固定用默认值（官方 6 个标准音色，或「自定义…」手填服务商音色名）；音色列表 API 不存在，故下拉为空。
- **连通性自检**：后台「TTS 配置」→「测试连接」。openai 协议用 `GET /v1/models` 探活（带 `Authorization`），cosyvoice 用容器 `/health`。
- **降级**：TTS 不可用时对话仍可进行，仅语音合成失败（消息旁标注），不影响文字回复。

## 4. 代码更新

源码为 bind mount，代码改动即时可见；容器启动时会自动检测源码是否比 `.next` 构建新，是则重建。更新流程：

```bash
git pull                       # 拉取最新源码
docker compose restart app     # 重启，启动时自动检测并重建 .next
```

> 首次使用本机制（即 `docker-compose.yml` 有变更）时，需用 `docker compose up -d` 让新配置生效，之后的更新只需 `restart`。
> 如需强制重建（如怀疑构建缓存异常），清空 `.docker/.next` 后重启，或执行 `docker compose exec app npm run build && docker compose restart app`。
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

## 5.1 会议录音（MP3）存储

feat-261101-01 起，服务端在转写的同时**旁路录制原始音频**，会议结束后转成 MP3 保存在本地磁盘。设计细节见 `docs/design/meeting-audio-recording.md`。

### 落点

```text
宿主机 <项目目录>/.docker/data/          ← 容器内 /app/data（compose 已 bind mount）
├── meeting-asr-app.db                  # 数据库（meeting_audio_recordings 表存元数据）
└── audio/
    ├── raw/<captureSessionId>.pcm      # 临时：旁路录制的原始 PCM，转码成功后自动删除
    └── meetings/<captureSessionId>.mp3 # 正式产物：绑定会议后永久保留
```

- **音频在本地磁盘，不在数据库里**：SQLite 只存路径（相对 `data` 目录）、字节数、时长、状态。
- **多实例部署必须共享卷**：`data/audio` 是本地目录；即便将来（#54 之后）把元数据外置到 MySQL / MSSQL，**音频文件仍在本机**。多个应用实例同时提供服务时，必须把 `data`（或至少 `data/audio`）挂成同一份共享卷（NFS/CIFS/云盘），否则 A 实例录的音在 B 实例上 404。当前运行时仍只支持 SQLite（见 §3.3.1），单实例零配置。
- 单实例（默认 compose 形态）零配置，无需改动。

### 容量估算

| 内容 | 体积 | 说明 |
|:---|:---|:---|
| 临时原始 PCM | **≈ 115 MB/小时/通道** | 16 kHz × 16 bit × 单声道 = 32 KB/s；双通道翻倍；转码成功后立即删除 |
| 正式 MP3（48 kbps） | **≈ 21 MB/小时/通道** | 48 kbps × 3600 / 8 ≈ 21.6 MB；码率可在后台「录音配置」调 32/48/64/96/128 |
| 峰值占用 | ≈ 136 MB/小时/通道 | 录制期间 PCM 与（转码后的）MP3 短暂共存 |

参考：100 场 1 小时双通道会议 ≈ 4.3 GB MP3。**已绑定会议的录音永久保留**（删会议才删文件），规划磁盘时按「一年内不删会议」估算。
未绑定会议的孤儿录音默认 72 小时后由后台定时任务清理（后台「录音配置」可调 1..8760 小时）。

### 备份与迁移

- 备份数据库的同时**必须一并备份 `data/audio/`**，否则恢复后会议详情里的播放器会 404（DB 行还在、文件没了）。最小可用备份：
  ```bash
  cp -a .docker/data/meeting-asr-app.db backup-$(date +%F).db
  tar czf backup-audio-$(date +%F).tar.gz -C .docker/data audio
  ```
- 换部署机迁移时，源码 + `.env` + `.docker/data`（**含 `audio/`**）三者一并迁移。
- `.docker/data/audio` 以 root 写入（容器以 root 运行），宿主机侧清理时注意权限。

### 开关与回滚

- 后台「录音配置」→ 关闭「服务端旁路录制会议音频」后，**新会议**不再落盘；已录好的音频不受影响。开关值存 `app_settings.audio:record_enabled`。
- 若需彻底停止录音能力，关闭开关即可；`data/audio` 中的既有文件可手工删除（DB 行残留会在详情页表现为 404，删除会议可连带清行）。

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
| 修改代码后不生效 | 容器启动时自动检测源码并重建，直接执行 `docker compose restart app`；若仍未生效，确认 `docker-compose.yml` 已是最新（`docker compose up -d` 应用新配置） |
| 需要彻底重置（重装依赖 + 重新构建） | `docker compose down` 后清空 `.docker/node_modules` 与 `.docker/.next` 再 `up -d` |
| 换部署机迁移 | 源码 + `.env` + `.docker/data`（数据库 + `audio/`）三者一并迁移即可 |
| 会议详情里播放器 404 / 没有录音 | ① 后台「录音配置」开关是否关闭；② `data/audio/meetings/` 是否有对应 mp3（迁移时漏了 `audio/` 目录最常见）；③ 转码失败时 DB 行 `status=failed`，`error_message` 记录原因且 `.pcm` 保留 |
| 磁盘被音频占满 | 调小 `audio:bitrate_kbps`、删除不需要的会议（连带删文件）、缩短 `audio:orphan_ttl_hours`；注意已绑定会议的录音不会自动过期 |
