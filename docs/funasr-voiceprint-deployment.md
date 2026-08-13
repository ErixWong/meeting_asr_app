# FunASR 声纹识别服务（说话人识别）部署指南

服务端声纹（CAM++ 说话人识别）独立容器的部署、配置与运维说明。功能为：录音转写后对每句音频做 1:N 声纹匹配，命中则把说话人姓名写入转写段（替代前端启发式聚类 ID）。

- 设计背景与决策：见 [design/funasr-voiceprint.md](design/funasr-voiceprint.md)
- ASR（转写）服务部署：见 [funasr-deployment.md](funasr-deployment.md)
- 主应用部署：见 [deployment-guide.md](deployment-guide.md)

## 1. 部署模型

```
┌────────────────────────── 宿主机 ──────────────────────────┐
│  funasr-voiceprint 容器（纯 Python stdlib HTTP 服务）      │
│    · CAM++ 模型（挂载 /docker/funasr/models，与 ASR 共享） │
│    · SQLite 声纹库 WAL → ./data/voiceprints.db            │
│    · 端口仅绑定 127.0.0.1:10097（无鉴权，只允许本机访问）  │
│                                                           │
│  主应用（Next.js）──/api/voiceprint/* 代理──► 127.0.0.1:10097
│  admin 后台「声纹管理」tab 是唯一配置界面                   │
└────────────────────────────────────────────────────────────┘
```

关键决策：
- **独立容器，与 ASR 转写服务逻辑隔离**（规避 CAM++ 挂全 ASR 管线内存不释放 issue #1808）
- 容器内无 fastapi/uvicorn，服务用 **Python 标准库** `http.server.ThreadingHTTPServer` 实现，零额外依赖
- 浏览器**不直连**声纹服务，一律经主应用 Next.js 代理转发
- 服务不可用时主应用**静默降级**到前端启发式聚类（30s 冷却），录音主流程零影响

## 2. 前置条件

| 项 | 要求 |
|---|---|
| Docker | 宿主机可运行 compose（`docker compose` 或 `sudo docker compose`） |
| 镜像 | `registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13`（与 funasr-online / funasr-online-sense 同源，部署 ASR 时已拉取） |
| 模型 | 宿主 `/docker/funasr/models/iic/speech_campplus_sv_zh-cn_16k-common` 与 `speech_campplus_sv_zh_en_16k-common_advanced`（容器内映射 `/workspace/models/...`，双语版约 28MB） |
| 主应用 | 已部署且含声纹功能版本（admin 后台有「声纹管理」tab） |
| 网络 | 主应用与声纹容器**同宿主机**（端口绑定 127.0.0.1，跨主机需自行改造鉴权） |

镜像与模型若缺失，先参考 [funasr-deployment.md](funasr-deployment.md) 部署 ASR 服务（会一并准备）。

## 3. docker-compose 配置

文件：`deploy/voiceprint/docker-compose.yml`（项目内已提供，含两个 service：`voiceprint` 中文版 + `voiceprint-en` 双语版，可直接使用）。要点：

- **镜像必须用完整 registry 名**，简名会误拉 docker.io 导致超时失败
- `voiceprint`：`VOICEPRINT_MODEL_DIR=...zh-cn_16k-common`，端口 `127.0.0.1:10097:10097`，声纹库 `./data`
- `voiceprint-en`：`VOICEPRINT_MODEL_DIR=...zh_en_16k-common_advanced`，端口 `127.0.0.1:10098:10097`，声纹库 `./data-en`
- 仅绑定宿主回环：服务无鉴权，只允许本机主应用代理访问（勿改 0.0.0.0）
- 内存各限 1G（实测中文版 ~410MB / 双语版 ~370MB）；healthcheck `start_period: 60s`（模型加载约 30~60s，期间未就绪属正常）

## 4. 部署步骤

```bash
cd /path/to/meeting_asr_app/deploy/voiceprint
docker compose up -d          # 无 docker 组权限时用：sudo docker compose up -d

# 等待模型加载（约 30~60s），然后验证（两个服务）：
curl http://127.0.0.1:10097/health   # 中文版
curl http://127.0.0.1:10098/health   # 双语版
# 期望：{"status":"ok","modelLoaded":true,"speakers":0,"threshold":0.35,...}
```

验证容器状态：

```bash
docker ps --filter name=funasr-voiceprint
# STATUS 应为 Up (healthy)；启动初期 (health: starting) 属正常，等 start_period 过后再看
```

## 5. 冒烟测试（可选）

使用模型自带示例音频（宿主路径）：

```bash
BASE=/docker/funasr/models/iic/speech_campplus_sv_zh-cn_16k-common/examples

# 注册说话人 A（speaker1_a_cn_16k.wav）
curl -X POST http://127.0.0.1:10097/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"测试A","format":"wav","audio":"<wav base64>"}'
# 期望：{"ok":true,"name":"测试A","samples":1,...}

# 识别另一段同人音频（speaker1_b_cn_16k.wav）
curl -X POST http://127.0.0.1:10097/identify \
  -H 'Content-Type: application/json' \
  -d '{"format":"wav","audio":"<wav base64>"}'
# 期望：{"matched":true,"speaker":"测试A","score":~0.7,...}
```

音频格式：`wav`（任意采样率/声道，自动重采样 16k 单声道）或 `pcm`（裸 s16le，需带 `sample_rate`，范围 8000~96000）。最短 0.2s，最长 60s。

## 6. 接入主应用（admin 后台）

1. 登录 admin 后台（`/admin`，需 `system_admin` 角色）
2. 打开「声纹管理」tab：
   - 确认顶部连通性状态为「可达」（绿点）
   - 「服务地址」保持 `http://127.0.0.1:10097`（与主应用同宿主机时）
   - 「识别阈值」默认 0.35：同人相似度 ~0.7、异人 ~0.0，调高更严格
   - 「启用服务端声纹识别」默认开启
3. 注册说话人：输入姓名 →「🎙 麦克风录音」录 ≥2 秒（或「上传音频」）→ 建议每人 2~3 段，多段取均值更稳
4. 返回会议页录音，每句 final 转写会自动做声纹识别，命中则显示人名

### 6.1 模型选择（英文会议）

「识别模型」下拉选择：**中文版 CAM++（中文会议）** 或 **中英双语版 CAM++（英文会议）**。

- 切换即时生效（保存配置即路由切换），两模型声纹库独立：**切到双语版后需在该库重新注册英文说话人**（英文名如 Alice/Bob 直接支持）
- 面板顶部显示两个服务的实时连通性/说话人数/阈值，当前使用模型带「使用中」标记
- 双语版实测：中文示例同人 0.67，内存 ~370MB；英文真实人声建议注册后按实际相似度微调阈值（同人一般 ≥0.5）

权限：配置仅 admin 可改；普通用户仅可查看状态。阈值保存即时生效（`PUT /config`），无需重启容器。

## 7. 数据与备份

| 项 | 位置 | 说明 |
|---|---|---|
| 声纹库 | `deploy/voiceprint/data/voiceprints.db`（中文版）/ `deploy/voiceprint/data-en/voiceprints.db`（双语版，SQLite WAL） | 说话人 → 192 维归一化向量（JSON），多段注册取均值；`meta` 表存阈值 |
| 模型 | 宿主 `/docker/funasr/models`（挂载，不随容器重建） | 与 ASR 共享，无需单独备份 |

备份声纹库（建议定期或迁移前）：

```bash
cd /path/to/meeting_asr_app/deploy/voiceprint
# 在线备份（SQLite WAL 安全）
python3 -c "import sqlite3; s=sqlite3.connect('data/voiceprints.db'); b=sqlite3.connect('data/voiceprints-backup.db'); s.backup(b); b.close(); s.close()"
```

恢复：把备份文件放回对应 `data/voiceprints.db` / `data-en/voiceprints.db` 后 `docker compose restart`。

## 8. 代码更新与升级

服务代码经 bind mount 挂载（`./voiceprint-server.py:/app/voiceprint-server.py:ro`）：

```bash
cd /path/to/meeting_asr_app/deploy/voiceprint
git pull                          # 更新项目代码（含 voiceprint-server.py）
docker compose up -d --force-recreate   # 容器重建即生效
```

主应用升级同理（重新构建镜像/重启应用进程）。

## 9. 常见问题

| 现象 | 原因与处理 |
|---|---|
| `/health` 返回 `modelLoaded:false` | 模型路径未挂载或镜像内模型缺失，检查 `VOICEPRINT_MODEL_DIR` 与宿主机 `/docker/funasr/models` |
| admin 后台「声纹管理」显示不可达 | ① 容器未启动：`docker compose up -d`；② 主应用与容器不同宿主机（端口仅绑定 127.0.0.1）；③ 端口被占用 |
| 录音时识别一直无反应（30s 冷却） | 声纹服务曾不可达，前端自动冷却 30s 后恢复；检查服务日志 `docker logs funasr-voiceprint` |
| 识别不准确 | 每人注册 2~3 段不同环境语音；调低阈值（误识变多）或调高（漏识变多） |
| 误删说话人 | 声纹库无回收站，用 §7 备份恢复 |
| 切换模型后说话人不见了 | 正常：两模型声纹库独立。在「识别模型」切回原模型查看，或在新模型库重新注册说话人 |
| 容器反复重启（OOM） | 内存上限 1G 被击穿：检查是否有大并发识别；`docker stats` 观察实际占用后调大 `deploy.resources.limits.memory` |
| 需要跨主机访问声纹服务 | 当前无鉴权设计，不建议直接暴露；需自行加 token 鉴权并放开端口绑定 |

## 10. 相关文档

- 设计文档：[design/funasr-voiceprint.md](design/funasr-voiceprint.md)（决策、约束、踩坑记录）
- 服务本地说明：[deploy/voiceprint/README.md](../deploy/voiceprint/README.md)（API 表）
- ASR 部署：[funasr-deployment.md](funasr-deployment.md)
- 主应用部署：[deployment-guide.md](deployment-guide.md)
