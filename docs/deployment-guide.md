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

- **基座**：`node:24-slim`（Debian bookworm / glibc），满足 `better-sqlite3@13` 的原生模块、`sharp@0.35.3` 与 `@next/swc-linux-x64-gnu` 的预编译二进制，无需编译工具链。
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
# 一般**不需要**配：网关会按「同源」自动放行（Origin 的 hostname+端口 == 请求 Host），
# 用 IP / 局域网 / 域名 / 换端口访问都能直接录音。
# 只有反向代理内外层 host 不一致（外层 nginx 改写 Host）时才需要显式列出，例如：
# ASR_GATEWAY_ALLOWED_ORIGINS=https://meeting.example.com
# 留空 ⇒ 网关内置默认（http://localhost:3123,http://127.0.0.1:3123）+ 同源判定生效。
# 判定规则见 docs/design/asr-gateway-origin.md
# 直接使用 http://host:3123 时设为 false；HTTPS 反向代理时设为 true
AUTH_COOKIE_SECURE=false
# 引导管理员（首次启动创建）
BOOTSTRAP_ADMIN_ACCOUNT=admin
BOOTSTRAP_ADMIN_PASSWORD=<强密码，勿用默认值>

# —— 数据库：默认 SQLite（零配置），无需任何配置 ——
# ⚠ DB_TYPE=mysql|mssql 在本版本「初始化 + 冒烟可跑通」，但**业务 SQL 的方言语法尚未清零**
#   （ON CONFLICT / INSERT OR IGNORE / PRAGMA table_info 等），生产**仍只支持 SQLite**，见 3.3.1。
# DB_TYPE=sqlite         # 默认；mysql / mssql 见 3.3.1 的真实支持面
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

**生产目前仅 SQLite 经过真机验证。** #54 之后运行时**已经真的读 `DB_TYPE`**（`server/db-shared.mjs` 的 `getDb()` → `getKnex()` → `AsyncDb`），三库的「初始化 + 冒烟」已在 CI 路径 `npm run db:test-parity` 里跑通；但**业务 SQL 的方言语法还没清零**，所以生产仍只支持 SQLite：

- **驱动变更（#54）**：SQLite 从 Node 内置的 `node:sqlite`（`DatabaseSync`，同步）换成 `better-sqlite3@13`（经 knex，Promise 化）。业务代码形态不变（仍是 `prepare(sql).all/get/run`），只是全部变成 `await`。
- **`DB_TYPE` 真实支持面**：`sqlite`（默认，生产已验证）／`mysql`、`mssql`（**建表 + 迁移 + 版本记账 + 生产入口初始化**已三库跑绿；业务 SQL 的 `ON CONFLICT` / `INSERT OR IGNORE` / `PRAGMA table_info` 等方言语法仍待 #55 清零，配上去会在具体业务路径上出错）。
- **连接级 PRAGMA 是条件化的**：`journal_mode=WAL` / `busy_timeout=5000` / `foreign_keys=ON` **只在 `DB_TYPE=sqlite` 时下发**（mysql/mssql 没有 `PRAGMA` 语法，实测 mssql 报 `Incorrect syntax near '='`）。WAL 在 Docker bind mount 上不可用时仍会打印原文告警，不静默降级。
- **SQLite 是单文件数据库**（`data/meeting-asr-app.db`），备份/迁移/换机见 §5（**不是拷文件**：WAL 库要用 `VACUUM INTO`）。
- ⚠ **同一库文件禁止混用两种 SQLite 驱动**：`node:sqlite` 与 `better-sqlite3` 交替写同一个文件会让 WAL 对彼此不可读（实测 `SQLITE_IOERR_SHORT_READ`）。生产只用 `better-sqlite3`；脚本/备份工具要读这个库时也必须用 `better-sqlite3`（`node:sqlite` 只在历史脚本里出现过）。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| ① #53 | 方言事实钉死 + 三库测试脚手架（零运行时变更） | 已完成 |
| ② #54 | 114 处裸 SQL 同步→异步、`getKnex()` 成为唯一入口、`DB_TYPE` 真正生效 | 已完成 |
| ③ #55 | 方言语法清零（`ON CONFLICT` / `INSERT OR IGNORE` / `PRAGMA`）+ 大小写语义落地 + 三库 CI | 待做 |

> 方言事实与待办清单：`docs/design/db-dialect-portability.md`。

### 3.3.2 外部实例连通性冒烟

```bash
# SQLite（默认，零配置）
node scripts/db-smoke.mjs

# 外部实例（冒烟 knex 基建；要真的让应用连过去，另配 DB_TYPE 等环境变量）
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

### 5.0 为什么不能 `cp`（#56 修正）

旧版本节写的是 `cp -a .docker/data/meeting-asr-app.db backup-$(date +%F).db` —— **对 WAL 库是错的**。

生产库是 **WAL 模式**（同目录有 `meeting-asr-app.db-wal` / `meeting-asr-app.db-shm`），最近提交的事务可能还只在 `-wal` 里、没 checkpoint 回主文件：只拷主文件 ⇒ 丢掉最近写入；连 `-wal` 一起拷又容易拿到不一致的中间态。正确做法是**让 SQLite 自己导出一份事务一致的副本**：`VACUUM INTO`（SQLite 3.27+，本机 3.53.4）。

所以备份动作统一交给 `scripts/db-backup.mjs`；`cp` 只出现在「恢复」那一步（且**必须先删 `-wal`/`-shm`**，见 §5.7）。

### 5.1 一键备份（`npm run db:backup`）

```bash
# 容器内（生产形态；默认输出到 /app/data/backups = 宿主 .docker/data/backups）
docker exec meeting_asr_app-app-1 node /app/scripts/db-backup.mjs

# 或宿主机走 npm（注意 SQLITE_PATH 要指宿主路径）
SQLITE_PATH=.docker/data/meeting-asr-app.db DB_BACKUP_DIR=/tmp/bk npm run db:backup
```

脚本做的事（顺序即安全边界，别调换）：

1. `DB_TYPE != sqlite` ⇒ **明确拒绝**：`RESULT: FAIL code=unsupported_db_type`，退出码 1（分叉见 §5.9）。不静默跳过——跳过会被 cron 当成「今天备份成功」。
2. 目标目录 `DB_BACKUP_DIR`（默认 `/app/data/backups`）不存在则创建。
3. `better-sqlite3` 打开生产库，**先 `PRAGMA busy_timeout = 5000`**（独立进程、独立连接，不继承应用侧的设置）。
4. `VACUUM INTO '<dir>/.<name>.tmp'` —— **先写临时名**。
5. `PRAGMA integrity_check` 打开临时文件（只读、同样是 `better-sqlite3`）必须返回 `ok`。
6. **才** rename 成 `<prefix>-YYYYMMDD-HHMMSS.db`（时间戳固定 UTC+8，与容器 `TZ` 无关）。同一秒内重复运行不覆盖已有备份，加序号 `-2` / `-3`。
7. 按 `DB_BACKUP_KEEP`（默认 14）保留最新 N 份，删旧的并逐个记日志。
8. 只读统计 `data/audio` 的字节数与文件数（不拷贝、不删除），打一行 `[backup] 音频用量…`。
9. 收尾打**机器可读一行**。

真实输出（2026-11-04 06:49 对生产库）：

```text
[backup] 音频用量（只统计不拷贝）: files=2 bytes=520128 dir=/app/data/audio
RESULT: OK file=/tmp/backup56/meeting-asr-app-20261104-064923.db bytes=245760 integrity=ok kept=1 removed=0 elapsed_ms=23
```

| 环境变量 | 默认 | 说明 |
|:---|:---|:---|
| `DB_TYPE` | `sqlite` | 非 sqlite 直接拒绝（退出码 1） |
| `SQLITE_PATH` | `<cwd>/data/meeting-asr-app.db` | 生产库路径 |
| `DB_BACKUP_DIR` | `/app/data/backups` | 备份目录（宿主等价 `.docker/data/backups`，compose 已挂载，零改动） |
| `DB_BACKUP_KEEP` | `14` | 保留份数；**`0` = 不做清理，只增不删** |
| `DB_BACKUP_PREFIX` | 库文件名去掉 `.db` | 备份文件名前缀 |
| `DB_AUDIO_DIR` | `<cwd>/data/audio` | 只用于统计 |

失败码（`RESULT: FAIL code=<码>`，退出码一律 1）：`unsupported_db_type` / `invalid_keep` / `db_missing` / `db_open_failed` / `backup_dir_create_failed` / `vacuum_failed` / `vacuum_empty` / `integrity_failed` / `rename_failed` / `unexpected_error`。

**失败不留半成品**：临时文件与 0 字节产物在校验失败时一律删除 ⇒ 目录里出现 `meeting-asr-app-*.db` 本身就意味着那是一份 `integrity_check=ok` 的备份。

### 5.2 每日自动备份（cron）

```bash
bash scripts/install-backup-cron.sh            # 默认只打印将要追加的行，不写 crontab
bash scripts/install-backup-cron.sh --install  # 真的写入（幂等：已存在同一行则跳过）
bash scripts/install-backup-cron.sh --check    # 已装退出码 0 / 未装 1（给监控用）
```

追加的行（本机 crontab 是**本地时区 UTC+8**，所以是每天 03:20）：

```cron
20 3 * * * docker exec meeting_asr_app-app-1 node /app/scripts/db-backup.mjs >> /home/eric/logs/meeting-asr-backup.log 2>&1
```

前提：`/home/eric/logs` 存在（不存在时安装脚本会告警——cron 不会替你建目录，失败是静默的）。
装之前先手动跑一次 §5.1 的命令，确认能出 `RESULT: OK`。

### 5.3 失败告警口径（三种判据，任一命中即告警）

| # | 判据 | 检查 |
|:---|:---|:---|
| 1 | 当天日志出现 `RESULT: FAIL` | `grep -q 'RESULT: FAIL' /home/eric/logs/meeting-asr-backup.log` |
| 2 | 当天没有新备份文件 | `ls .docker/data/backups/meeting-asr-app-$(date +%Y%m%d)-*.db` 为空 |
| 3 | 最近一次不是 `integrity=ok`（含进程被杀、没打出 RESULT 行） | `grep 'RESULT: OK' … \| tail -1 \| grep -qv 'integrity=ok'` |

一条能直接挂进监控的：

```bash
LOG=/home/eric/logs/meeting-asr-backup.log
BK=/home/eric/projects/meeting_asr_app/.docker/data/backups
fail=0
grep -q 'RESULT: FAIL' "$LOG" && fail=1
grep 'RESULT: OK' "$LOG" | tail -1 | grep -q 'integrity=ok' || fail=1
ls "$BK"/meeting-asr-app-"$(date +%Y%m%d)"-*.db >/dev/null 2>&1 || fail=1
[ "$fail" -eq 0 ] || echo "备份异常：$(date -Is)" | tee -a "$LOG"
```

### 5.4 保留份数与容量

- 默认保留 **14** 份（约两周），按文件名里的时间戳排序，删最旧。
- `DB_BACKUP_KEEP=0` = **只增不删**（显式语义，单测钉住）。只在「外部快照负责清理」时这么配。
- 容量：库年增约 0.2–2 GB，14 份 ≈ 当前库体积 × 14，仍是 MB 级；**音频不在这条链里**（见 §5.5 与 §6）。

### 5.5 音频（MP3）不进每日备份——边界与两选一

音频年增 26–155 GB，比库大**两个数量级**。混进每日备份的后果：① 备份窗口从秒级变小时级；② 14 份保留策略直接吃掉数 TB。所以**默认边界：每日备份只管数据库**。音频二选一：

1. **宿主机快照 / 外部备份负责（默认边界）**：`data/audio` 跟着整机/整卷快照走，库里只存路径与元数据。
2. **单独一条增量 cron（需要时才装，默认不装）**：

```cron
30 3 * * * rsync -a --delete /home/eric/projects/meeting_asr_app/.docker/data/audio/ /mnt/backup/meeting_asr/audio/ >> /home/eric/logs/meeting-asr-audio-backup.log 2>&1
```

⚠ 用 `--delete` 前先确认目标盘够大、且目标确实是「镜像」而非「历史归档」。**恢复一致性**要求库与音频来自同一时间点，否则详情页播放器会 404（DB 行还在、文件没了）。

### 5.6 恢复演练记录（2026-11-04 真跑，issue #56 判据 2）

用**当天真跑出来的那份备份**（不是手工造的）走完整链路：

```text
# 1) 对生产库真跑一次备份（备份目录指到容器 /tmp，避免污染 .docker/data）
$ docker exec meeting_asr_app-app-1 sh -c 'DB_BACKUP_DIR=/tmp/backup56 node /app/scripts/db-backup.mjs'
RESULT: OK file=/tmp/backup56/meeting-asr-app-20261104-064923.db bytes=245760 integrity=ok kept=1 removed=0 elapsed_ms=23

# 2) 拷到临时目录并改名成正式库名
$ docker cp meeting_asr_app-app-1:/tmp/backup56/meeting-asr-app-20261104-064923.db /tmp/restore56/meeting-asr-app.db
$ ls -la /tmp/restore56/meeting-asr-app.db     →  245760 字节

# 3) integrity_check 原文（宿主侧 better-sqlite3 只读）
integrity_check = [{"integrity_check":"ok"}]
tables = 16   (app_settings … users)
meetings = 0  users = 1

# 4) 临时实例：端口 3125、数据目录指向临时目录（独立容器，不碰生产容器与生产 data）
$ docker run -d --name meeting_asr_restore56 --rm -v $PWD:/app:ro … -v /tmp/restore56:/app/data \
    -e PORT=3125 -e SQLITE_PATH=/app/data/meeting-asr-app.db -p 3125:3125 node:24-slim node server/app-server.mjs
[DB] SQLite ready: /app/data/meeting-asr-app.db (journal_mode=wal)
[App Server] Production server running on http://0.0.0.0:3125

$ curl -X POST :3125/api/auth/login -d '{"accountName":"admin","password":"admin123"}'
login http=200  {"user":{"id":"user-admin","accountName":"admin","roles":["system_admin"]}}
$ curl -b cookie :3125/api/meetings
{"meetings":[]}      ← 0 条，与生产库一致（生产库 meetings 本来就是 0）

# 5) 证明恢复库**可读写**（不只是能打开）：建一条会议再读回
post http=200  {"meeting":{"id":"meeting-1f75e8c8-…","title":"恢复演练-261104-01","status":"transcribed"}}
{"meetings":[{"title":"恢复演练-261104-01", …}]}    ← 1 条
（演练后再跑 integrity_check 仍为 ok，meetings = 1）

# 6) 拆除 + 清理（ls 证明）
$ docker rm -f meeting_asr_restore56                 → meeting_asr_restore56
$ docker exec meeting_asr_app-app-1 rm -rf /tmp/backup56
$ rm -rf /tmp/restore56
$ ls -la /tmp/restore56                              → No such file or directory
$ docker ps | grep -c restore56                      → 0
```

结论：**今日真备份 → `integrity_check=ok` → 临时实例能登录、能读、能写 → 已清理干净**。
一处偏差（如实记录）：生产 `admin` 密码早已不是 `admin123`，为了验证登录，只在**恢复副本**上把 admin 的 `password_hash` 重置成 `admin123`（`scrypt-v1` 格式，与 `src/lib/admin-store.ts` 一致）；**生产库未改动**（`.docker/data` 下各文件 mtime 与本单开始时一致）。

### 5.7 从备份恢复（正式流程）

```bash
# 1. 停应用（避免恢复过程中有写入）
docker compose stop app

# 2. 先把当前库留个底（这一步仍是 cp，但只是「保命」，不是正式备份）
cp -a .docker/data/meeting-asr-app.db .docker/data/meeting-asr-app.db.before-restore-$(date +%Y%m%d-%H%M%S)

# 3. ⚠ 必须删掉旧 WAL/SHM：恢复进来的库与旧 -wal 不是一套，留着会被 SQLite 当成本库日志
rm -f .docker/data/meeting-asr-app.db-wal .docker/data/meeting-asr-app.db-shm

# 4. 把备份放成正式库名
cp .docker/data/backups/meeting-asr-app-20261104-064923.db .docker/data/meeting-asr-app.db

# 5. 起回来并确认
docker compose start app
docker compose logs --tail 30 app | grep -E "SQLite ready|migration|schema_version"
```

验收：能登录、`GET /api/meetings` 的条数与备份时点一致；`npm run db:smoke` 通过。
回滚：把第 2 步的 `.before-restore-*` 放回去（同样先删 `-wal`/`-shm`）。

### 5.8 安全告警与驱动告警

- ⚠ **备份文件含明文密钥**：`app_settings` 里有 `llm.api_key`（以及 ASR / TTS / SMTP 密钥）。备份目录必须按密钥对待——不要进 git、不要丢共享盘/网盘、目录 `chmod 700`、异地传输前加密（`age` / `gpg`）。
- ⚠ **同一库文件禁止混用两种 SQLite 驱动**：`node:sqlite` 与 `better-sqlite3` 交替写同一文件会 `SQLITE_IOERR_SHORT_READ`（实测）。备份/校验脚本只用 `better-sqlite3`；手工排查也请走 `docker exec … node -e "require('better-sqlite3')…"`，不要用系统 `sqlite3` CLI 对着生产文件做写操作。

### 5.9 换 MSSQL / MySQL 后：备份方式分叉（#55）

`scripts/db-backup.mjs` 是 **SQLite 专用**的。`DB_TYPE=mssql|mysql` 时它**明确拒绝**：

```text
RESULT: FAIL code=unsupported_db_type      （退出码 1）
```

（不许静默跳过：跳过会被 cron 当成「今天备份成功」。）外置库的备份方式与 SQLite 完全不同：

- **MSSQL**：`BACKUP DATABASE meeting_asr TO DISK = '/var/opt/mssql/backup/meeting_asr-YYYYMMDD.bak' WITH CHECKSUM, COMPRESSION;`，再用 `RESTORE VERIFYONLY FROM DISK = '…'` 校验（等价于 `integrity_check`）。
- **MySQL / MariaDB**：`mysqldump --single-transaction --routines --triggers --set-gtid-purged=OFF … | gzip`，恢复用 `mysql < dump.sql`。
- 库外还有 `data/audio`（本地文件，永远跟着宿主机走，见 §5.5）。

cron 行如何按 `DB_TYPE` 分叉、告警口径如何复用：见 **issue #55**。

### 5.10 可选加固：把备份目录挪到 `/docker/meeting_asr_app_backup`

默认备份目录 `.docker/data/backups` 与库同盘——盘坏了库和备份一起没。要分开就：

```bash
# 1. 宿主建目录（/docker 是 root:root 755，eric 不可写，必须 sudo）
sudo mkdir -p /docker/meeting_asr_app_backup
sudo chown 1000:1000 /docker/meeting_asr_app_backup   # 容器内以 root 跑，宿主侧映射成 eric

# 2. compose 的 app.volumes 里加一行（放在 ./.docker/data:/app/data 之后）
#      - /docker/meeting_asr_app_backup:/app/data/backups
docker compose up -d app     # 新增 volume 要 up -d 才生效（restart 不够）
```

生效后脚本默认的 `DB_BACKUP_DIR=/app/data/backups` 就落到 `/docker/meeting_asr_app_backup`，脚本本身不用改。
（可选加固，本单**没有**安装——见 report 的「诚实边界」。）

## 6. 会议录音（MP3）存储

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

- 数据库走 §5.1 的备份脚本（**不要 `cp`**：WAL 库会拿到不一致快照）；音频走 §5.5 的二选一（宿主机快照，或单独一条 `rsync -a --delete` cron）。两者必须来自**同一时间点**，否则恢复后会议详情里的播放器会 404（DB 行还在、文件没了）。
- 只想要一次性打包（迁移场景，非日常备份）：
  ```bash
  docker exec meeting_asr_app-app-1 node /app/scripts/db-backup.mjs   # 库
  tar czf backup-audio-$(date +%F).tar.gz -C .docker/data audio        # 音频
  ```
- 换部署机迁移时，源码 + `.env` + `.docker/data`（**含 `audio/`**）三者一并迁移。
- `.docker/data/audio` 以 root 写入（容器以 root 运行），宿主机侧清理时注意权限。

### 开关与回滚

- 后台「录音配置」→ 关闭「服务端旁路录制会议音频」后，**新会议**不再落盘；已录好的音频不受影响。开关值存 `app_settings.audio:record_enabled`。
- 若需彻底停止录音能力，关闭开关即可；`data/audio` 中的既有文件可手工删除（DB 行残留会在详情页表现为 404，删除会议可连带清行）。

## 7. 安全注意事项

- **必须**设置 `BOOTSTRAP_ADMIN_PASSWORD`，默认 `admin123` 仅限开发。
- ASR WebSocket 的 Origin 判定：**同源（Origin 的 hostname+端口 == 请求 Host）自动放行**，
  所以 `http://127.0.0.1:3123`、局域网 IP、域名访问都开箱可用，不必每次配 env。
  只有反向代理**改写了 Host**（外层 `Host` 与浏览器 `Origin` 不一致）时才需要把实际
  Origin 写进 `ASR_GATEWAY_ALLOWED_ORIGINS`（逗号分隔）。缺 `Origin` 头的请求一律拒绝。
  判定细节与日志样例见 `docs/design/asr-gateway-origin.md`。
- 如果通过 HTTPS 反向代理访问，将 `AUTH_COOKIE_SECURE` 设为 `true`；如果直接通过 HTTP 访问 3123 端口，保持为 `false`，否则浏览器不会发送登录 cookie。
- 当前容器以 root 运行；如需加固，可在 compose 增加 `user: "node"` 并对 `.docker/` 目录 `chown -R node:node`。
- 敏感配置（ASR/LLM/SMTP 密钥）存于 SQLite，注意 `.docker/data` 的访问权限。

## 8. 常见问题

| 现象 | 原因与处理 |
|:---|:---|
| 容器反复重启 / healthcheck 不通过 | 首次构建未完成，查看 `docker compose logs app`；确认网络可访问 npm registry |
| 页面能打开，但录音/转写 WebSocket 失败（页面顶部有红色「实时转写连接失败」告警） | 看 `docker compose logs app` 里的 `Rejected client origin:` 一行：`origin=` 是浏览器实际地址、`allowedOrigins=` 是生效白名单。若两者不同源（多为反代改写了 Host），把 `origin=` 的值加进 `.env` 的 `ASR_GATEWAY_ALLOWED_ORIGINS` 后重启容器 |
| 修改代码后不生效 | 容器启动时自动检测源码并重建，直接执行 `docker compose restart app`；若仍未生效，确认 `docker-compose.yml` 已是最新（`docker compose up -d` 应用新配置） |
| 需要彻底重置（重装依赖 + 重新构建） | `docker compose down` 后清空 `.docker/node_modules` 与 `.docker/.next` 再 `up -d` |
| 换部署机迁移 | 源码 + `.env` + `.docker/data`（数据库 + `audio/`）三者一并迁移即可 |
| 会议详情里播放器 404 / 没有录音 | ① 后台「录音配置」开关是否关闭；② `data/audio/meetings/` 是否有对应 mp3（迁移时漏了 `audio/` 目录最常见）；③ 转码失败时 DB 行 `status=failed`，`error_message` 记录原因且 `.pcm` 保留 |
| 磁盘被音频占满 | 调小 `audio:bitrate_kbps`、删除不需要的会议（连带删文件）、缩短 `audio:orphan_ttl_hours`；注意已绑定会议的录音不会自动过期 |
