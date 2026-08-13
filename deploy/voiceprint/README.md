# FunASR 声纹识别服务（独立容器）

会议纪要系统服务端声纹（CAM++ 说话人识别）容器。与 ASR 转写服务逻辑隔离（规避 CAM++ 挂全 ASR 管线内存不释放 issue #1808）。

## 部署

```bash
cd deploy/voiceprint
docker compose up -d        # 或 sudo docker compose up -d
curl http://127.0.0.1:10097/health
```

要求：
- 宿主已有镜像 `registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13`（与 funasr-online / funasr-online-sense 同源）
- 模型已就位于宿主 `/docker/funasr/models/iic/speech_campplus_sv_zh-cn_16k-common`（容器内映射 `/workspace/models/...`）

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | 健康检查（modelLoaded / speakers / threshold） |
| POST | /embedding | 音频 → 192 维 embedding `{audio: base64, format?: "wav"\|"pcm", sample_rate?}` |
| POST | /register | `{name, audio, format?, sample_rate?}` 注册/追加样本（均值 embedding） |
| POST | /identify | `{audio, format?, sample_rate?}` → `{matched, speaker, score, elapsedMs, top}` |
| GET | /speakers | 说话人列表 |
| DELETE | /speakers/{name} | 删除说话人 |
| GET/PUT | /config | 阈值查询 / `{threshold}` 更新（默认 0.35） |

音频格式：`wav`（任意采样率/声道，自动重采样 16k 单声道）或 `pcm`（裸 s16le 需带 sample_rate）。识别阈值 0~1，推荐 0.35（同人相似度 ~0.7，异人 ~0.0）。

## 与主应用的关系

- 主应用经 Next.js 代理 `/api/voiceprint/*` 转发（`src/lib/voiceprint-server.ts`），浏览器不直连本服务
- 端点/启停在 admin 后台「声纹管理」tab 配置（app_settings: `voiceprint:endpoint` / `voiceprint:enabled`）
- 服务不可用时主应用静默降级到前端启发式聚类（`src/lib/voiceprint.ts`），录音主流程零影响

## 数据

- 声纹库：`deploy/voiceprint/data/voiceprints.db`（SQLite WAL，随 compose 持久化）
- 模型：复用宿主挂载 `/docker/funasr/models`（不随容器重建丢失）
- 内存：实测运行 ~450MB，compose 上限 1G
