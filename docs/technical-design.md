# 智能会议纪要系统 — 技术设计

> 本文档描述当前代码实现的实际架构与模块设计。配套文档：[UI 交互设计](./ui-interaction-design.md)、[认证产品化](./auth-productization.md)、[FunASR 模型说明](./funasr-models.md)、[设计决策](./design/)。

## 1. 项目概述

构建一个基于 Web 的智能会议纪要系统：通过 ASR Gateway 统一接入 FunASR 服务进行实时语音识别，结合 OpenAI 兼容 LLM（如 `qwen3.6-35b`）自动生成结构化会议纪要，支持实时翻译、邮件发送与后台配置管理。

当前实现以本地部署的 FunASR WebSocket 服务（2pass 协议）为默认上游，并保留阿里云 DashScope FunASR 作为兼容兜底；两者通过后台 ASR 配置切换。

### 1.1 核心能力

- 实时语音转文字（流式 ASR，partial / final 双通道）
- 双路采集：多麦克风 + 系统声音（`source` 区分 `mic` / `speaker`），录音中支持单路麦克风静音
- ASR 语种选择（`svs_lang`：auto / zh / en / ja / ko / yue）
- 说话人识别（双层：服务端 CAM++ 注册制 1:N 识别 + 浏览器端特征聚类兜底）
- 音频文件上传转写（上传音视频经同一 ASR 管线转写生成会议）
- LLM 驱动的会议纪要自动生成（多模板、多版本）
- 实时 / 历史 / 选中文本翻译（版本化持久化）
- 录音中断自动保存与恢复（ASR 故障 checkpoint，`paused` 状态可续录）
- 英文会议全链路支持（SenseVoice 多语种 ASR + 双语声纹 + 英文模板）
- 语音朗读（Web Speech API）
- 邮件发送（SMTP）与发送审计
- 后台管理界面（RBAC、审计日志、连接测试、声纹管理）
- 统一 HTTP + WebSocket 服务（`server/app-server.mjs`）

任务/行动项跟踪不属于当前产品范围；如后续需要，应作为独立产品开发，消费本系统输出的转写文本或会议纪要。

### 1.2 架构总览

```
浏览器 (Next.js)
  麦克风采集 / 系统声音 → Web Audio API (ScriptProcessorNode, PCM 16kHz)
      │
      │  WebSocket  (src/lib/funasr.ts，每路一个 FunASRClient)
      ▼
ASR Gateway  (server/asr-gateway.mjs, 挂载 /asr)
      │  按 app_settings.asr.provider 选择适配器
      ├── 本地 FunASR（2pass WebSocket，如 Paraformer / SenseVoice）
      └── DashScope FunASR（阿里云，兼容兜底）
      │  原始事件写入 asr_capture_sessions / asr_capture_events
      ▼
Next.js API Routes（/api/meetings /api/admin /api/auth /api/translate /api/voiceprint/* ...）
      │
      ▼
admin-store.ts（SQLite + 认证 + RBAC）
      ├── SQLite 持久化（data/*.db）
      ├── LLM（OpenAI 兼容 /chat/completions，经全局队列 src/lib/llm-queue.ts）
      └── 独立声纹服务代理（deploy/voiceprint，CAM++，端口 10097 中文 / 10098 双语）
```

## 2. 技术栈

| 类别 | 技术 | 版本 | 说明 |
|:---|:---|:---|:---|
| 框架 | Next.js (App Router) | 15 | 全栈 React 框架，API Routes 做后端代理 |
| 语言 | TypeScript | 5.x | 类型安全 |
| UI 样式 | Tailwind CSS | 3.x | 原子化 CSS |
| 数据库 | SQLite（`node:sqlite` 内置模块） | built-in | 本地零依赖 |
| 状态管理 | Zustand | 4.x | 轻量级 |
| ASR 客户端 | 自研 `src/lib/funasr.ts` | - | 浏览器端固定连接 ASR Gateway |
| 音频采集 | Web Audio API（ScriptProcessorNode） | - | 浏览器原生，提取 PCM 16kHz |
| ASR 网关 | WebSocket（`ws`） | 8.x | 浏览器 ↔ 上游 ASR 中转 |
| LLM | OpenAI 兼容 API（如 `qwen3.6-35b`） | - | 纪要/翻译/测试共用 |
| 邮件 | Nodemailer | 9.x | SMTP 发送 |
| 语音朗读 | Web Speech API | 内置 | 朗读转写/纪要/选中文本 |
| 声纹识别 | 独立 Python 服务（stdlib HTTP + CAM++ `speech_campplus_sv_zh-cn_16k-common`） | 独立容器 | 注册制 1:N 识别；中文版 10097 / 中英双语版 10098 |

## 3. 详细设计

### 3.1 音频采集模块

#### 3.1.1 设备枚举与选择

通过 `navigator.mediaDevices.enumerateDevices()` 获取所有音频输入设备；用户从 `DeviceSelector` 选择目标设备，将 `deviceId` 传入 `getUserMedia()`。

- 设备 label 在授权前为空；需先 `getUserMedia()` 获取权限后再次 `enumerateDevices()` 才能拿到完整名称；设备下拉框展开时触发权限刷新（`requestMicrophonePermission`）
- 采集配置：16kHz、单声道、关闭 echoCancellation / noiseSuppression / autoGainControl
- 多路：每个选中麦克风一路采集（`deviceId` 区分），另有 `speaker` 路采集系统声音（`getDisplayMedia` 共享整个屏幕以采到所有应用声音，视频轨立即停止），录音期间配置在弹窗中锁定，下次录音生效
- 单路静音：录音中「静音」开关仅对 `key !== "speaker"` 的 mic 路调用 `FunASRClient.pause()/resume()`（不断会话、不关连接），speaker 路不受影响，整体状态保持 `recording`

#### 3.1.2 PCM 提取

使用 `AudioContext.createScriptProcessor(4096, 1, 1)` 从 `MediaStream` 提取 16kHz 单声道 PCM Int16 数据：

```typescript
this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
this.scriptProcessor.onaudioprocess = (event) => {
  const inputData = event.inputBuffer.getChannelData(0); // Float32Array [-1,1]
  const pcm16 = convertFloat32ToInt16(inputData);        // Int16Array
  ws.send(pcm16.buffer);
};
```

音频文件上传路径：`decodeAudioData` → 重采样至 16kHz → 转 Int16 → 同样经 WebSocket 送入 Gateway。

#### 3.1.3 转写段来源契约

`TranscriptSegment`（前后端 + 存储 JSON 三方共享）：

```ts
interface TranscriptSegment {
  id: string;
  speaker: string;
  speakerId?: number | null;
  source?: "mic" | "speaker";   // 采集通道类型（非说话人身份）
  deviceId?: string;             // mic 路的具体设备 id；speaker 路为 undefined
  text: string;
  time: string;
  timeSeconds: number;
  isFinal: boolean;
}
```

说话人身份由 `speakerId` 表达；`source` 只区分 mic/speaker 两类。多路各自一个 `FunASRClient` + 网关会话（`captureSessionId` 区分）。final 段到达时客户端按 `beginTime/endTime` 从本地音频缓冲切出该句音频（`extractAudioSegment`），供浏览器端特征提取与服务端声纹识别使用。详见 [设计决策 asr-dual-channel.md](./design/asr-dual-channel.md)。

### 3.2 ASR Gateway

`server/asr-gateway.mjs` 是浏览器与 ASR 服务之间的统一代理层，浏览器只连接本服务 `/asr` 路径：

- 新连接时从 SQLite 读取 ASR 配置（provider、endpoint、api key、workspace id）与启用热词
- 自动将 `http://...` 规范化为 `ws://.../ws`；本地模式剥离 DashScope `Authorization` 头
- 将 DashScope 风格 `run-task` / `finish-task` 转换为本地 FunASR 2pass 初始化报文（`mode:"2pass"`、`chunk_size`、`chunk_interval`、`is_speaking` 等）与结束报文（`is_speaking:false` / `is_eof:true`）
- 为前端合成 `task-started` / `task-finished`，并把上游结果重包装为前端消费的 `result-generated`
- 透传 `svs_lang` 会话参数；在网关层剥离 SenseVoice 标签（`<|lang|><|emotion|><|event|>`），原始消息保留在 capture events
- 结果文本取值优先级：`text` → `text_2pass` → `asr_result`；`isFinal = is_final || is_eof || mode 含 offline`
- 将所有原始 ASR 事件写入 `asr_capture_sessions` / `asr_capture_events`
- Origin 白名单校验；生产环境 WebSocket 握手要求有效登录 session（过期、强制改密、无业务角色均拒绝）

### 3.3 前端转写状态机

`src/lib/transcript-state.ts` 维护多通道转写状态：

- partial 按 `(source, deviceId)` 隔离：从后往前定位“同来源最后一段”，未 final 则更新，否则追加；避免多路互相覆盖
- final 才落最终段；partial 走节流合并（`PARTIAL_RENDER_INTERVAL_MS` + pending 缓冲）避免高频闪烁
- 计时器以 `timerRef.current === null` 守卫防重复；声纹特征按路隔离（`Map<deviceId, VoiceprintFeature[]>`）
- checkpoint：ASR 故障中断时先 `materializeCheckpointTranscript` 固化 pending partial 并 `finalizeTranscriptSegments` 落定所有段，再自动保存会议（无会议则创建，已有则 PATCH 追加新段），会议标记 `paused`；恢复录制时重连会话并保留已保存转写（`persistedSegmentCountRef` 记录已落库段数，恢复后只追加新段）

### 3.4 说话人识别（双层：服务端注册制 + 浏览器端聚类兜底）

说话人识别为双层架构：**服务端 CAM++ 注册制 1:N 识别**为主（识别出人名），**浏览器端特征聚类**为兜底（服务不可用时保证“能区分”）。

#### 3.4.1 服务端声纹识别（CAM++）

独立声纹服务容器（`deploy/voiceprint/voiceprint-server.py`，纯 Python stdlib HTTP + SQLite）：

- 模型：CAM++ `speech_campplus_sv_zh-cn_16k-common`（192 维 embedding，CPU 推理）；中文版容器端口 10097，中英双语版端口 10098，两模型声纹库各自独立
- 接口：`/health`、`/embedding`、`/register`（说话人注册，多段取均值归一化）、`/identify`（1:N 余弦匹配 + 阈值，默认 0.35）、`/speakers`、`/config`
- 主应用经 `/api/voiceprint/*` 代理（`src/lib/voiceprint-server.ts`，5s 超时，服务不可达抛 `VoiceprintUnavailableError`）；identify 仅登录用户可调，register/speakers 增删/config 修改仅 `system_admin`
- 接入点（`page.tsx`）：final 段提交后异步调 `/identify`（音频 ≥0.2s/3200 样本才触发，与服务端 MIN 对齐），命中则用人名覆盖该段 `speaker` 字段（随会议持久化）；不阻塞录音主流程
- 降级：服务不可达 → 冷却 30s 静默降级，期间不再发起请求，浏览器端聚类照常工作；`voiceprint:enabled` 可全局关闭

#### 3.4.2 浏览器端特征聚类（兜底）

`src/lib/voiceprint.ts` 实现（服务端不可用或未命中注册人时生效）：

- `transcript.final` 时用 `extractAudioSegment` 从本地音频缓冲切出该句音频
- 提取 12 维声纹特征（RMS、基频 F0 自相关法、频谱质心/带宽/滚降/平坦度/通量，Web Audio API → 自实现 Cooley-Tukey FFT）
- 余弦相似度 + 阈值聚类（默认 0.6），按路分配说话人 ID，段显示回退为“说话人 N”

详见 [设计决策 funasr-voiceprint.md](./design/funasr-voiceprint.md) 与 [英文会议支持](./english-meeting-support.md)。

### 3.5 LLM 对接模块

#### 3.5.1 API 格式

LLM 使用 OpenAI 兼容格式，经 `src/lib/admin-store.ts` 服务端调用（密钥不落到前端）：

- 配置项：`llm:base_url`、`llm:api_key`、`llm:model`、`llm:context_size`、`llm:max_tokens`、`llm:timeout_ms`
- 纪要：系统模板 + `{transcript}` 占位符 → 结构化 Markdown 纪要，多模板、多版本
- 翻译：`translateSentences`（批量句子）与 `translateSelection`（任意文本）
- 推理模型思考模式：`llm:thinking_model` 默认开启，自动附加关闭思考参数；结果用 `stripLeadingThinking` 清理思考内容

#### 3.5.2 全局 LLM 队列

`src/lib/llm-queue.ts` 进程内信号量 + FIFO 队列，**所有 LLM 调用统一过闸**（翻译/纪要/手动/测试）：

- 并发上限 = `llm:max_concurrency`（默认 2）；排队容量 = `llm:queue_capacity`（默认 10），超出直接拒绝
- 排队等待上限：translate/test 30s、summary 300s，超时返回“LLM 繁忙”
- 单例挂 `globalThis`（防 dev HMR 重置）；槽位持有到任务结束（`finally` 释放）
- **禁止嵌套入队**：历史翻译管线外层占槽后，内层批直连 `translateSentences` 串行执行
- 队列状态 `GET /api/llm-queue-status`（BUSINESS_ROLES）：`{inFlight, queued, dropped}`

### 3.6 翻译体系

- **实时**：final 句缓存（不送 partial），攒满 N 句（`llm:translate_trigger_sentences`，默认 3）或距上次 10s 触发一次经 `/api/translate` 批翻；in-flight 守卫 + 会话代数（`translateGenerationRef`）防竞态；失败不清缓冲，下次自动重发；停止录音强制 flush
- 源=目标语言（非 auto）自动切换目标语言；`/api/translate` 返回 `elapsedMs` 供 UI 显示“最近 Xs”
- **历史**：`/api/meetings/:id/llm-results` 触发 `translateMeetingFlow`，final 句分批（≤5 句/≤1000 字）串行直连 `translateSentences`，全成写 succeeded / 任批失败写 failed
- **选中**：`/api/translate-selection` 翻译任意选中文本
- **持久化**：零 schema 迁移，复用 `meeting_llm_results` 版本化存储；`result_type='translation'`、`version_no` 全局递增、`input_transcript_snapshot` 存原文、`generation_config_snapshot` 存 `{targetLang, source}`。系统翻译模板 `system_translate`（id=`tpl-translate`）无条件 upsert
- **摘要派生约束**：`listMeetings` / `queryMeetingRowById` 的 `summary` 子查询取“最新成功结果”，必须排除 `result_type='translation'`，避免译文顶替纪要

详见 [设计决策 llm-queue-and-translation.md](./design/llm-queue-and-translation.md)。

### 3.7 语音朗读

`src/components/tts/TtsProvider.tsx` 封装 Web Speech API：

- 朗读当前可朗读文本（转写/纪要）或任意选中文本
- 优先选择中文语音（`/^zh(-|_)/i`），否则回退 `zh-CN`
- 通过 `selectionchange` 监听检测是否有选中文本，支持朗读/停止切换

### 3.8 认证与权限

- 会话：`auth_sessions`，Cookie 会话，TTL 7 天；密码使用 `scrypt-v1` 方案
- 首次启动自动创建引导管理员；`must_change_password` 强制改密
- API 角色守卫 `src/lib/api-auth.ts`：后台管理相关路由要求 `system_admin`，业务路由要求 `user`/`system_admin`（BUSINESS_ROLES）
- 密钥类设置（`asr:api_key`、`llm:api_key`、`mail:smtp_password`）不回传前端，仅存服务端

### 3.9 数据库设计

SQLite（`node:sqlite`），schema 定义于 `server/database-schema.mjs`。表结构演进走版本化迁移机制：`schema_version` 表 + 有序 `MIGRATIONS` 列表 + `runMigrations`（初始化顺序：建表 → 迁移 → 依赖迁移产物的索引），详见 [性能与数据架构设计约束 perf-and-storage.md](./design/perf-and-storage.md)。

| 表 | 用途 |
|:---|:---|
| `app_settings` | 键值配置（ASR/LLM/Mail/队列/声纹 `voiceprint:*` 等） |
| `llm_prompt_templates` | 提示词模板（含系统翻译模板） |
| `asr_hotwords` | ASR 热词 |
| `users` | 用户（scrypt 密码、强制改密等） |
| `roles` | 角色 |
| `user_roles` | 用户-角色关联 |
| `auth_sessions` | 登录会话 |
| `meetings` | 会议主表 |
| `meeting_asr_results` | 会议转写结果（含原始 payload） |
| `meeting_llm_results` | 纪要/翻译版本化结果 |
| `meeting_send_records` | 邮件发送记录 |
| `asr_capture_sessions` | ASR 采集会话 |
| `asr_capture_events` | ASR 原始事件 |
| `audit_logs` | 审计日志（服务端定时清理） |

## 4. 页面设计

### 4.1 主界面（`/`）

- 默认界面保持简洁：开始录音 / 上传音频两个入口 + 状态行（录音状态、计时、队列徽章）
- 录音配置移入「开始录音」弹窗（`RecordSetupModal`）：设备选择（麦克风多选 + 系统声音开关 + 设备刷新授权）、ASR 语种、翻译开关与目标语言；确认后开始录制
- 录音中：转写区实时滚动字幕（partial 实时刷新，final 落段，按路区分）、翻译区实时译文、单路麦克风静音开关、暂停 / 恢复 / 停止
- 历史翻译（目标语言 + 版本按钮行 V1/V2...，失败红 / 处理中琥珀）、选中文本翻译弹窗（教学辅助）
- 纪要与版本：markdown 预览、版本切换、重新生成
- 队列徽章：显示 `队列 N · 处理中 N` 与最近翻译耗时

### 4.2 管理界面（`/admin`）

| Tab | 内容 |
|:---|:---|
| ASR 配置 | Provider、端点、API Key、Workspace ID、连接测试 |
| LLM 配置 | Base URL、API Key、模型、上下文/最大 Tokens/超时、全局并发/排队长度、翻译触发句数、思考模型、调用测试 |
| 邮件配置 | SMTP 主机/端口/账号、发件人、默认主题/签名、连接测试 |
| 提示词模板 | 模板列表、新增、编辑、停用、默认模板设置 |
| 热词管理 | 热词列表、新增、编辑、停用、删除 |
| 声纹管理 | 启停开关、识别模型（中文 / 中英双语）、端点配置、连通性测试、说话人注册（录音/上传）、列表/删除、阈值 |
| 用户与角色 | 用户管理、密码重置、角色分配 |
| 审计日志 | 最近关键操作记录 |

敏感配置只允许后台读写，普通页面经 `/api/config` 仅获取非敏感摘要（如 ASR 是否已配置、翻译触发句数）。

## 5. 项目结构

```
meeting_asr_app/
├── docs/                        # 部署、模型、设计文档
│   └── design/                  # ADR：数据流、双路 ASR、LLM 管线、队列与翻译、权限、性能、服务端声纹
├── server/
│   ├── app-server.mjs           # 统一 HTTP/WS 入口（Next.js + ASR Gateway + 清理定时器）
│   ├── asr-gateway.mjs          # ASR Gateway（DashScope / Local FunASR 适配）
│   ├── database-schema.mjs      # SQLite 表结构 + 版本化迁移
│   ├── db-shared.mjs            # 共享 DB 工具
│   └── runtime-store.mjs        # Gateway 运行配置读取 + 采集会话存储
├── deploy/
│   └── voiceprint/              # 独立声纹服务（voiceprint-server.py + docker-compose，中文/双语双容器）
├── scripts/
│   ├── check-dev-ports.mjs      # 开发端口检查
│   └── probe-service.mjs        # TCP/HTTP/WS 服务探测
├── src/
│   ├── app/                     # 页面 + API Routes（/api/{config,meetings,translate,translate-selection,llm-queue-status,voiceprint,admin,auth}）
│   │   ├── login/               # 登录页
│   │   └── change-password/     # 强制改密页
│   ├── components/
│   │   ├── main/                # RecordingControls、RecordSetupModal、DeviceSelector、TranscriptView、TranslationView、HistoryList、HotWordManager、MarkdownPreview、AsrResultDetailView
│   │   ├── admin/               # VoiceprintPanel（声纹管理 tab）
│   │   ├── tts/                 # TtsProvider、TtsReadableSync
│   │   └── layout/              # AppHeader
│   ├── lib/                     # admin-store、api-auth、funasr、voiceprint、voiceprint-server、voiceprint-audio、voiceprint-api、transcript-state、llm-queue、use-auth-session、meeting-status、store-utils、mockData、auth-constants
│   └── types/index.ts           # 类型定义
├── docker-compose.yml
├── middleware.ts
├── next.config.mjs
└── package.json
```

## 6. 核心流程

### 6.1 开始录音

```
1. 拉取 /api/config 获取非敏感配置（ASR 是否已配置、翻译触发句数）
2. 点击「开始录音」打开配置弹窗：检查 FunASR 服务连通性、刷新设备列表、勾选麦克风与系统声音、选择语种与翻译目标
3. 确认后为每路 createAudioContext + getUserMedia/getDisplayMedia
4. 每路创建 FunASRClient（携带语种 svs_lang），建立 WebSocket 到 /asr
5. ScriptProcessorNode 输出 PCM → WebSocket 发送
6. 接收 transcript.partial（实时字幕）/ transcript.final（落段 + 触发声纹识别/聚类 + 进入翻译缓存）
7. 显示录音状态与队列徽章
```

### 6.2 停止录音

```
1. 强制 flush 翻译缓存（绕过阈值）
2. 关闭各路麦克风/流与 AudioContext，发送结束信号（is_speaking:false）
3. 等待最终识别结果，合并转写，按说话人分段
4. 写入实时翻译（/api/meetings/:id/live-translation，纯持久化）
5. 保存会议（含转写）到 SQLite
6. 刷新历史列表；可选触发纪要生成
```

#### 6.2.1 录音中断自动保存与恢复（checkpoint）

```
ASR 连接失败（onError）
  → 停止所有 ASR 会话，固化 pending partial 并落定全部段（materializeCheckpointTranscript）
  → 自动保存：无会议则 POST /api/meetings 创建（status 由客户端标记），已有则 PATCH 追加新段
  → 会议标记 paused（/api/meetings/:id PATCH status=paused），界面显示「已暂停」与错误信息
  → 用户点「恢复」：等待 checkpoint 落库完成后重连 ASR 会话（startRecording 保留转写），
    仅上传自上次保存以来的新段（persistedSegmentCountRef 记录已落库段数）
```

### 6.3 音频文件上传转写

```
选择音频/视频文件
  → decodeAudioData 解码 → 重采样 16kHz → 转 Int16 → 按 3200 样本分块
  → 单路 WebSocket 会话逐块发送（20ms 间隔限速），实时返回 partial/final
  → 转写结束命名保存会议（sourceType=file）
```

### 6.4 服务端声纹识别（final 句）

```
transcript.final 且句音频 ≥0.2s
  → 浏览器端先做特征聚类（兜底，得到 speakerId）
  → 异步 POST /api/voiceprint/identify（Float32Array → int16 PCM base64）
  → 声纹服务 CAM++ 提取 192 维 embedding → SQLite 1:N 余弦匹配 + 阈值
  → 命中 {matched, speaker, score} → 用注册人名覆盖该段 speaker 字段（随会议持久化）
  → 服务不可用 → 冷却 30s，期间静默降级，聚类结果照常使用
```

### 6.5 纪要 / 翻译生成

```
用户点击生成 / 目标语言翻译
  → 校验会议有 final 转写段
  → llmQueue.enqueue(type)（纪要 300s / 翻译 30s 等待上限）
  → 服务端调用 LLM（纪要：模板渲染；翻译：分批直连 translateSentences）
  → 结果按 version_no 写 meeting_llm_results（result_type: summary / translation）
  → 前端 2s 轮询直至 succeeded / failed
```

## 7. 环境变量

| 变量 | 说明 | 默认 |
|:---|:---|:---|
| `PORT` | 统一应用服务监听端口 | `3123` |
| `APP_HOST` | 统一应用服务监听地址 | `0.0.0.0` |
| `ASR_GATEWAY_PATH` | ASR Gateway WebSocket 路径 | `/asr` |
| `ASR_GATEWAY_ALLOWED_ORIGINS` | 允许的 WebSocket 来源 | `http://localhost:3123,...` |
| `BOOTSTRAP_ADMIN_ACCOUNT` | 引导管理员账号 | `admin` |
| `BOOTSTRAP_ADMIN_PASSWORD` | 引导管理员密码 | `admin123`（仅开发） |
| `DEV_ACTOR_ACCOUNT` | 开发环境自动登录账号 | — |

## 8. 已知边界与后续方向

- 全局 LLM 队列为单进程实现；多实例部署需 Redis 协调（未实现）
- 多实例扩展示范可参考 [deployment-guide.md](./deployment-guide.md) 与 `nginx-meeting-asr.conf`
- 服务端声纹（CAM++）必须独立进程/容器运行（与 ASR 全管线隔离，避免 #1808 内存不释放场景）；仅支持 CAM++，不用 ERES2NetV2（#1438 OOM）；两模型声纹库各自独立，切换模型需在对应库重新注册；音频当前不持久化（远期：音频持久化 + 离线重识别），详见 [funasr-voiceprint.md](./design/funasr-voiceprint.md)
- 英文会议依赖 SenseVoice 多语种 ASR + 双语声纹 + 英文模板，三层可独立启用，详见 [english-meeting-support.md](./english-meeting-support.md)

✌Bazinga！
