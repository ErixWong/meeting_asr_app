# FunASR 声纹识别服务（独立容器）

会议纪要系统服务端声纹（CAM++ 说话人识别）容器。与 ASR 转写服务逻辑隔离（规避 CAM++ 挂全 ASR 管线内存不释放 issue #1808）。

## 双服务（admin「声纹管理」面板选择当前使用）

| 服务 | 模型 | 端口 | 声纹库 | 适用会议 |
|---|---|---|---|---|
| funasr-voiceprint | 中文版 `speech_campplus_sv_zh-cn_16k-common` | 127.0.0.1:10097 | `./data/voiceprints.db` | 中文 |
| funasr-voiceprint-en | 中英双语版 `speech_campplus_sv_zh_en_16k-common_advanced` | 127.0.0.1:10098 | `./data-en/voiceprints.db` | 英文/中英混合 |

两库独立：切换模型后需在对应库重新注册说话人（中文版实测：同人 0.69~0.82 vs 异人 ~0.0；双语版对中文示例同人 0.67，英文真实录音建议注册后实测阈值）。

## 部署

```bash
cd deploy/voiceprint
docker compose up -d        # 或 sudo docker compose up -d（同时拉起两个容器）
curl http://127.0.0.1:10097/health   # 中文版
curl http://127.0.0.1:10098/health   # 双语版
```

要求：
- 宿主已有镜像 `registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13`（与 funasr-online / funasr-online-sense 同源）
- 模型已就位于宿主 `/docker/funasr/models/iic/speech_campplus_sv_zh-cn_16k-common` 与 `speech_campplus_sv_zh_en_16k-common_advanced`（容器内映射 `/workspace/models/...`；双语版缺失时可参照模型卡片下载）

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
- **模型选择**：admin 后台「声纹管理」tab 下拉选择当前模型（`voiceprint:model`），代理按模型路由到对应容器；双服务各自连通性实时显示
- 端点/启停在 admin 后台「声纹管理」tab 配置（app_settings: `voiceprint:model` / `voiceprint:endpoint_zh` / `voiceprint:endpoint_zh_en` / `voiceprint:enabled`）
- 服务不可用时主应用静默降级到前端启发式聚类（`src/lib/voiceprint.ts`），录音主流程零影响

## 数据

- 声纹库：`deploy/voiceprint/data/voiceprints.db`（中文版）、`deploy/voiceprint/data-en/voiceprints.db`（双语版，SQLite WAL，随 compose 持久化）
- 模型：复用宿主挂载 `/docker/funasr/models`（不随容器重建丢失）
- 内存：实测中文版 ~410MB / 双语版 ~370MB，compose 各限 1G
