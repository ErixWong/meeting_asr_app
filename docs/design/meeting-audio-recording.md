# 会议录音落盘为 MP3（feat-261101-01）

> 对应 issue #43。三条产品决策：① **服务端旁路录原始 PCM，会议结束后转 MP3**（不在浏览器编码）；② **已绑定会议的录音永久保留**（删会议才删文件）；③ **孤儿录音 72 小时后清理**。

## 1. 链路

```text
浏览器 /asr WS ──┬─► 上游 FunASR（原有转发路径，不受影响）
  (PCM s16le     │
   16 kHz 单声道) └─► server/audio-recorder.mjs  ── append ──► data/audio/raw/<captureSessionId>.pcm
                                                                    │
                                           会话终态（finish/fail/close）│ finalize()（幂等）
                                                                    ▼
                                             meeting_audio_recordings 行：bytes / duration_seconds
                                                                    │ enqueueAudioTranscode()（setImmediate）
                                                                    ▼
                              server/audio-transcode.mjs（@breezystack/lamejs）
                                                                    │
                                          ┌─────────────────────────┴──────────────────────┐
                                     成功 ▼                                           失败 ▼
              data/audio/meetings/<captureSessionId>.mp3                     保留 .pcm
              行 status=ready、删 .pcm、raw_file_path=NULL                     行 status=failed + error_message
                                                                    │
                         会议落定（createMeeting / appendMeetingTranscript）│ bindAudioRecordingsToMeeting
                                                                    ▼
                                          meeting_id 写入、expires_at=NULL（永久保留）
                                                                    │
                                     GET /api/meetings/<id>/audio（Range 流式）→ <audio controls>
```

要点：

- **旁路不碰转发**：`append()` 内部吞掉所有写错误（只打日志 + 记 `writeError`），绝不让录制失败触发 `failSession`。
- **流式写、流式读**：录制用 `fs.createWriteStream`，转码按 13824 字节（6912 样本）分块 `readSync`，全程不把整场 PCM（1 小时 ≈ 115 MB）读进内存。
- **不阻塞事件循环太久**：lamejs 是纯 JS，转码每 32 块 `await setImmediate()` 让出；任务本身由 `setImmediate` 异步排队，WS 会话收尾与 HTTP 响应先返回。
- **不依赖 ffmpeg**：实测 60 秒 16 kHz 单声道 → 48 kbps MP3 约 360 KB、耗时约 1 秒（≈16× 实时），容器保持 `node:24-slim`。

## 2. 表结构：`meeting_audio_recordings`

schema_version = 3（迁移 `meeting-audio-recordings`）。新库走基线建表，旧库走迁移，两处共用同一个建表 helper（幂等）。

| 列 | 类型 | 说明 |
|:---|:---|:---|
| `id` | string(64) PK | **`aud-<uuid>`**（见 §6） |
| `capture_session_id` | string(64) **UNIQUE** | 与 `/asr` 的 capture session 一一对应；重复登记走 upsert |
| `meeting_id` | string(64) nullable | 绑定后写入；FK → `meetings(id)` ON DELETE CASCADE |
| `file_path` | string(500) nullable | MP3 存储路径（**相对 data 目录**，如 `audio/meetings/capture-xxx.mp3`） |
| `raw_file_path` | string(500) nullable | PCM 存储路径（`audio/raw/capture-xxx.pcm`）；转码成功后被清空 |
| `format` | string(16) | 目前恒为 `mp3` |
| `status` | string(32) | `recording` / `ready` / `failed` |
| `bytes` | bigint | MP3 字节数（转码后）；转码前为 PCM 字节数 |
| `duration_seconds` | float | 时长 = `bytes / 2 / sample_rate`（以 PCM 字节为准） |
| `sample_rate` | integer | 默认 16000（取自 `session.start` 的 `audio.sampleRate`） |
| `bitrate_kbps` | integer nullable | 转码码率，ready 时写入 |
| `error_message` | text nullable | 失败原因（转码错误 / 无音频数据） |
| `created_at` / `updated_at` | string(32) | 应用侧写 ISO8601，DDL 不设 `DEFAULT CURRENT_TIMESTAMP` |
| `expires_at` | string(32) nullable | **NULL = 永久**；未绑定时 = 创建时间 + 孤儿 TTL（默认 72h） |

索引：`idx_meeting_audio_recordings_meeting(meeting_id)`、`idx_meeting_audio_recordings_expires(expires_at)`。

**路径存相对 data 目录**（而不是绝对路径）的原因：容器内外 `/app/data` 与宿主机 `.docker/data` 不同，换挂载点/迁移机器不用改数据；`resolveStoredPath()` 还原绝对路径并对 `..` 穿越兜底。

## 3. 状态机

```text
           registerAudioRecording()                  finalize() 有字节
  (会话开始) ─────────────────► recording ─────────────────────────────► recording
                                     │                                      │ 转码成功
                                     │ finalize() 无字节/写失败              ▼
                                     └──────────────► failed            ready（终态）
                                                          ▲                 │
                                                          │ 转码失败         │ 幂等：已是 ready 直接跳过
                                                          └─────────────────┘
```

- `recording` 覆盖「PCM 已落盘、MP3 待转码」这段窗口（会话收尾后通常几秒内变成 `ready`）。
- `ready` / `failed` 为终态；`runAudioTranscodeJob` 对 `ready` 幂等跳过（目标 mp3 在就返回）。
- 开关 `audio:record_enabled=0` 期间产生的会话**不建文件、不登记行**。

## 4. 清理策略

| 场景 | 行为 |
|:---|:---|
| 会议落定（`createMeeting` / `appendMeetingTranscript`） | `meeting_id` 写入 + `expires_at = NULL`（永久保留）；同时接受单数 `captureSessionId` 与复数 `captureSessionIds`，取并集去重 |
| 删除会议（`deleteMeeting`） | 事务内先取行、再删会议（FK 级联清行），提交后删磁盘文件（MP3 + 残留 PCM）；回滚不丢文件 |
| 孤儿录音 | `meeting_id IS NULL AND expires_at < now` → 删行 + 删文件。`server/app-server.mjs` 启动即跑一次 + 每小时一次 + `.unref()` |
| 转码失败 | 保留 `.pcm`（便于排查/重试），行置 `failed` + `error_message` |

孤儿 TTL 由 `audio:orphan_ttl_hours` 控制（默认 72，范围 1..8760）。

## 5. HTTP 语义：`GET /api/meetings/<id>/audio`

| 参数 | 含义 |
|:---|:---|
| （无） | 该会议**第一条** `ready` 录音 |
| `?recording=<id>` | 指定录音（接受 `aud-<uuid>` 主键或 `capture-<uuid>`） |
| `?download=1` | 追加 `Content-Disposition: attachment`，文件名 `${会议标题}.mp3`（多通道带 `-1`/`-2`） |

| 请求 | 响应 |
|:---|:---|
| 无 `Range` | `200` + `Content-Length` 全量 |
| `Range: bytes=a-b` / `a-` / `-N` | `206` + `Content-Range: bytes a-b/total` + `Content-Length` + `Accept-Ranges: bytes` |
| 语法错 / 起点越界 / `start>end` | `416` + `Content-Range: bytes */total` |
| 无录音 / 非本人会议 / 文件丢失 | `404` |

- 鉴权：`withRequiredRoles(req, BUSINESS_ROLES, ...)` + 会议属主校验（`ensureMeetingOwned`），与其它会议接口一致。
- `Content-Type: audio/mpeg`；**流式返回**（`createReadStream` + `Readable.toWeb`），不整块读入内存。
- Range 解析抽在 `src/lib/http-range.ts`（纯函数，单测覆盖 200/206/416 三条分支）。

## 6. ID 约定（显式偏离上级 §3.4）

`~/projects/AGENTS.md` §3.4 的单调 ID 约定在本项目**整体未落地**：现库所有表主键都是 `store-utils.newId(prefix) = "<prefix>-<uuid>"`（`meeting-…` / `asr-…` / `llm-…` / `tpl-…` / `audit-…`）。

本单**沿用项目现状**：`meeting_audio_recordings.id = "aud-" + randomUUID()`（node 侧 `runtime-store.mjs` 里直接生成，形状与 TS 侧 `newId("aud")` 一致）。理由：半库两套 ID 方案比统一用现状更糟。**前缀 `aud` 在此登记**。

## 7. 双通道行为

- 双通道（麦克风 + 系统声音）时，两条 ASR 连接各有独立 capture session，因此**一次会议产生 2 条录音行 / 2 个 MP3**。
- 前端 `stopRecording` / `saveAsrCheckpoint` / 上传落定都会把 `asrClientsRef` 里**全部** session id 用 `captureSessionIds: string[]` 上报（旧的单数 `captureSessionId` 仍兼容）。
- 会议详情页逐条列出 `<audio controls>` + 下载链接；`status=failed` 折叠显示 `error_message`。
- 通道顺序 = 创建时间顺序（`ORDER BY created_at ASC, id ASC`），不保证与「麦克风/扬声器」语义一一对应（未存通道标签）。

## 8. 相关配置（`app_settings`，明文，非密钥）

| key | 默认 | 校验 |
|:---|:---|:---|
| `audio:record_enabled` | `1`（开） | `0/false/no/off` → 关，其它 → 开 |
| `audio:bitrate_kbps` | `48` | 白名单 32 / 48 / 64 / 96 / 128 |
| `audio:orphan_ttl_hours` | `72` | 整数 1..8760 |

读取走 `runtime-store.getAudioRuntimeConfig()`（**带缓存**，每个 ASR 会话取一次，PCM 帧回调里不查库）；`saveSettings` 时 `invalidateAudioRuntimeConfig()` 失效。
