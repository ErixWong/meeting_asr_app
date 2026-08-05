# 智能会议纪要系统 �?技术设计方�?

## 1. 项目概述

构建一个基�?Web 的智能会议纪要系统，通过 FunASR 服务进行语音识别和说话人区分，结合本�?Qwen3.6-35b LLM 自动生成结构化会议纪要。当前实现已从阿里云 DashScope FunASR 迁移为优先接入本地部署的 FunASR WebSocket 服务，并保留原有云端路径作为兼容兜底�?

### 1.1 核心能力

- 实时语音转文字（流式 ASR�?
- 说话人识别与分段（Speaker Diarization�?
- USB 声卡设备选择（支�?Jabra 等外置设备）
- LLM 驱动的会议纪要自动生�?- 历史会议记录管理
- 管理员配置界面（声纹、LLM、提示词�?
任务/行动项跟踪不属于当前产品范围；如后续需要，应作为独立产品开发，并消费本系统输出的转写文本或会议纪要�?
### 1.2 架构总览

```
┌──────────────────────────────────────────────────────────────�?
�?                    Browser (Next.js)                         �?
�?                                                              �?
�? ┌────────────�? ┌──────────────�? ┌──────────────────────�? �?
�? �?麦克风采�?  �? �?设备选择      �? �?历史记录 / 管理界面   �? �?
�? �?Web Audio   �? �?enumerate-   �? �?React + Tailwind     �? �?
�? �?API         �? �?Devices()    �? �?                     �? �?
�? └──────┬─────�? └──────────────�? └──────────────────────�? �?
�?        �?PCM 16kHz Int16                                     �?
�?        �?                                                    �?
�? ┌───────────────────�?      ┌────────────────────────────�? �?
�? �?src/lib/funasr.ts │──────▶│ ASR Gateway                �? �?�? �?(Browser WS)      �?      �?server/asr-gateway.mjs     �? �?�? └─────────┬─────────�?      �? �?Local FunASR / DashScope�? �?
�?           �?                └────────────────────────────�? �?
�?           �?                                                �?
�?           �?                ┌────────────────────────────�? �?
�?           └────────────────▶│ Next.js API Route          �? �?
�?                             �? �?Qwen /v1/chat/completions�?�?
�?                             └────────────────────────────�? �?
└────────────┼─────────────────────────────────────────────────�?
             �?WebSocket
             �?
    ┌──────────────────�?
  �?Local FunASR     �?
  �?(2pass WS Server)�?
    �?Paraformer + CAM++�?
    └──────────────────�?
```

---

## 2. 技术栈

| 层级 | 选型 | 版本 | 说明 |
|------|------|------|------|
| 框架 | Next.js (App Router) | 14+ | 全栈 React 框架，API Routes 做后端代�?|
| 语言 | TypeScript | 5.x | 类型安全 |
| UI 样式 | Tailwind CSS | 3.x | 原子�?CSS |
| 组件�?| shadcn/ui | latest | 基于 Radix UI，无 style-inject，兼�?Tailwind |
| ASR 客户�?| 自研 `src/lib/funasr.ts` | - | 浏览器端固定连接 ASR Gateway `ws://localhost:8123` |
| 音频采集 | Web Audio API | - | 浏览器原生，AudioWorklet 提取 PCM |
| LLM | Qwen3.6-35b | - | OpenAI 兼容 API 格式 |
| 数据�?| SQLite (better-sqlite3) | - | 本地持久�?|
| 状态管�?| Zustand | 4.x | 轻量�?|

---

## 3. 详细设计

### 3.1 音频采集模块

#### 3.1.1 设备枚举

通过浏览�?`navigator.mediaDevices.enumerateDevices()` 获取所有音频输入设备�?

```typescript
// 获取所有音频输入设�?
const devices = await navigator.mediaDevices.enumerateDevices();
const audioInputs = devices.filter(d => d.kind === 'audioinput');

// 包含�?
// - 内置麦克�?
// - USB Jabra 设备
// - 其他外接声卡
```

**注意�?* 设备 label 在未授权前为空字符串。需要先调用 `getUserMedia()` 获取权限后，再次 `enumerateDevices()` 才能获取完整设备名称�?

#### 3.1.2 设备选择

用户从下拉框选择目标设备，将 `deviceId` 传入 `getUserMedia()`�?

```typescript
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    deviceId: { exact: selectedDeviceId },
    sampleRate: 16000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
});
```

#### 3.1.3 PCM 提取

使用 `AudioWorklet` �?MediaStream 中提�?16kHz 单声�?PCM Int16 数据�?

```typescript
// audio-processor.ts (AudioWorklet processor)
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0][0]; // Float32Array, [-1, 1]
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    this.port.postMessage(pcm16.buffer);
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
```

### 3.2 FunASR 对接模块

#### 3.2.1 当前连接方式

浏览器端不再直接连接云端 FunASR，而是统一连接本地 **ASR Gateway** `ws://localhost:8123`。Gateway 在每次新�?WebSocket 连接时读�?SQLite 中的当前 ASR 配置和启用热词，决定上游目标�?
- `app_settings.asr.provider = local_funasr` 时，连接本地部署�?FunASR 服务
- `app_settings.asr.provider = dashscope` 时，连接阿里�?DashScope FunASR
- `asr_hotwords.status = active` 的热词会在连接首帧注入本�?FunASR

当前代码落点�?
- `src/lib/funasr.ts`：浏览器录音、PCM 编码、发�?`run-task` / `finish-task`
- `server/asr-gateway.mjs`：协议转换、上游连接、事件兼容、热词注入、原�?ASR 事件采集
- `server/runtime-store.mjs`：供 Gateway 读取 SQLite 运行配置和写�?`asr_capture_sessions`
- `src/app/api/config/route.ts`：向前端只暴�?ASR 是否已配置，不下发密钥、Workspace ID 或真实上游鉴权信�?
Gateway 会将 `http://host:10095` 自动规范化为 `ws://host:10095/ws`。ASR 密钥、Workspace ID 和真实上游地址均停留在后端侧，普通录音页面只连接本地 Gateway�?
#### 3.2.2 流式音频发�?

将浏览器采集�?PCM Int16 数据通过 WebSocket 实时发送到 ASR Gateway，再�?Gateway 转发到上�?FunASR�?
```typescript
scriptProcessor.onaudioprocess = (event) => {
  const inputData = event.inputBuffer.getChannelData(0);
  const pcmData = convertFloat32ToInt16(inputData);
  ws.send(pcmData.buffer);
};
```

#### 3.2.3 本地 FunASR 协议兼容�?

本地部署�?FunASR 2pass WebSocket 服务与阿里云 DashScope 的消息协议不同，不能只替�?URL。实际联调中确认存在以下差异�?

- 浏览器端原先发送的�?DashScope 风格 `run-task` / `finish-task`
- 本地 FunASR 期望的是原生 2pass 初始化报文，例如 `mode: "2pass"`、`chunk_size`、`chunk_interval`、`is_speaking: true`
- 本地 FunASR 不会返回 DashScope 风格�?`task-started`
- 本地 FunASR 返回的识别结果字段更接近 `text` / `text_2pass` / `is_final`

为避免大面积改动前端录音逻辑，当前在 `server/asr-gateway.mjs` 中增加了兼容层：

1. 浏览器仍然只连接 `ws://localhost:8123`
2. Gateway 收到 `run-task` 后，转换为本�?FunASR 2pass 初始化报�?3. Gateway 向浏览器合成 `task-started`，并携带 `capture_session_id`
4. Gateway �?`finish-task` 转换�?`is_speaking: false` �?`is_eof: true`
5. Gateway 将本�?FunASR 的返回结果重新包装为前端原本消费�?`result-generated`
6. Gateway 将上游原�?ASR 事件写入 `asr_capture_sessions`，供会议保存时落�?`meeting_asr_results.raw_payload`

原生 FunASR 2pass 初始化示意：

```json
{
  "mode": "2pass",
  "chunk_size": [5, 10, 5],
  "chunk_interval": 10,
  "encoder_chunk_look_back": 4,
  "decoder_chunk_look_back": 0,
  "audio_fs": 16000,
  "wav_format": "pcm",
  "wav_name": "meeting-task-id",
  "is_speaking": true,
  "itn": true,
  "hotwords": "项目�?术语 缩写",
  "svs_lang": "auto",
  "svs_itn": true
}
```

#### 3.2.4 说话人识�?

FunASR 服务端需启用 CAM++ 说话人模型。识别结果中包含说话�?ID�?

- WebSocket 协议：通过 `stamp_sents` 字段中的 `spk` 获取
- OpenAI 兼容 API：通过 `segments[].speaker` 获取

需要在管理界面配置声纹 ID �?姓名的映射关系�?

#### 3.2.5 从阿里云 FunASR 迁移到本�?FunASR 的原因与分析

本次迁移不是简单的配置替换，而是一次接入形态变化。原始实现依赖阿里云 DashScope FunASR，核心特征是�?

- 上游地址�?Workspace ID 拼接得到
- 连接时携�?`Authorization: Bearer <apiKey>`
- 客户端等�?`task-started` 后才开始发送音�?
- 结果格式�?`header.event + payload.output.sentence`

迁移到本地部�?FunASR 的主要原因：

1. 语音数据不再经过公有云，便于满足内网和数据合规要求�?
2. 上游服务由本地容器控制，便于排障、升级模型和统一运维�?
3. 减少对阿里云 workspace、认证方式和公网可达性的依赖�?
4. 便于后续结合本地说话人模型、热词和专有词表做针对性优化�?

迁移过程中实际遇到的问题�?

1. 地址层问题：浏览器需要的不是 `http://host:10095`，而是 WebSocket 端点 `ws://host:10095/ws`�?
2. 协议层问题：本地 FunASR 虽然接受 WebSocket 握手，但不会�?DashScope 协议返回 `task-started`�?
3. 首包差异：透传 `run-task` 时，本地 FunASR 不返回识别消息；改为原生 2pass 初始化后可正常返回结果�?
4. 生命周期差异：前端点击停止时发送的�?`finish-task`，本�?FunASR 实际需�?`is_speaking: false`�?
5. 前端状态问题：页面首次渲染时配置尚未回填，可能误提示“未配置 FunASR”�?

针对这些问题，项目中的落地修改如下：

- `server/asr-gateway.mjs`
  - 新连接时读取 SQLite 中的 ASR provider、endpoint、api key、workspace id
  - 自动�?`http://...` 规范化为 `ws://.../ws`
  - 本地模式下移�?DashScope `Authorization` �?
  - �?DashScope 风格 `run-task` 转为 FunASR 2pass 初始�?JSON
  - �?`finish-task` 转为 `is_speaking: false` / `is_eof: true`
  - 为前端合�?`task-started` �?`task-finished`
  - 将本�?FunASR 返回结果重包�?`result-generated`

- `src/app/api/config/route.ts`
  - 只返�?`asr.isConfigured` 等非敏感摘要，供前端判断是否可以开始录�?
- `src/app/page.tsx`
  - 录音开始前按需重新拉取 `/api/config`
  - 使用 Gateway 返回�?`capture_session_id` 保存会议，便于关联后端采集的原始 ASR 事件

- `package.json`
  - 将开发启动脚本改�?`concurrently`
  - 新增 `asr-gateway` 脚本

- `scripts/probe-service.mjs`
  - 新增服务探测脚本，用于判断目标端口是 TCP 可达、HTTP 服务还是 WebSocket 服务

当前方案的收益：

- 前端录音逻辑保持基本不变，改动集中在 ASR Gateway
- 保留原阿里云接入路径，迁移风险可�?- 本地与云端两种模式可通过管理后台配置切换

当前仍需持续关注的点�?
- 本地 FunASR 返回字段可能因镜像版本不同而变化，结果映射需要继续以实际日志为准
- 默认 LLM 清洗当前为同�?post-commit 调用，后续如果耗时明显，应改为后台任务或增加超时治�?
### 3.3 LLM 对接模块

#### 3.3.1 API 格式

Qwen3.6-35b 使用 OpenAI 兼容格式，通过 Next.js API Route 代理调用�?

```
POST /api/llm
Content-Type: application/json

{
  "messages": [
    { "role": "system", "content": "系统提示�?.." },
    { "role": "user", "content": "以下是一段会议转写记录：\n\n..." }
  ],
  "temperature": 0.3,
  "max_tokens": 4096
}
```

#### 3.3.2 系统提示词模�?

```
你是一个专业的会议纪要助手。请根据以下会议转写记录，生成结构化的会议纪要�?

要求�?
1. 识别会议主题
2. 提炼各发言人要�?
3. 总结关键结论
4. 列出待办事项（如有）
5. 使用 Markdown 格式输出

转写记录�?
{transcript}
```

### 3.4 数据库设�?

使用 SQLite 存储，表结构如下�?

#### 3.4.1 系统配置�?(config)

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PRIMARY KEY | 配置键名 |
| value | TEXT | 配置值（JSON 序列化） |
| updated_at | DATETIME | 最后更新时�?|

配置项包括：
- `funasr_endpoint` �?FunASR WebSocket 地址
- `qwen_api_url` �?Qwen API 地址
- `qwen_api_key` �?Qwen API 密钥
- `system_prompt` �?系统提示�?
- `default_device_id` �?默认音频设备

#### 3.4.2 会议记录�?(meetings)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增 ID |
| title | TEXT | 会议标题（可自动/手动生成�?|
| transcript | TEXT | 完整转写文本 |
| summary | TEXT | LLM 生成的会议纪�?|
| speaker_map | TEXT | 说话人映�?JSON |
| duration | INTEGER | 会议时长（秒�?|
| created_at | DATETIME | 创建时间 |

#### 3.4.3 声纹�?(voiceprints)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增 ID |
| spk_id | INTEGER | FunASR 返回的说话人 ID |
| name | TEXT | 显示名称 |
| description | TEXT | 备注 |

---

## 4. 页面设计

### 4.1 主界�?(`/`)

布局�?

```
┌─────────────────────────────────────────────────────�?
�? Header: 智能会议纪要系统                  [管理] [设置] �?
├────────────┬────────────────────────────────────────�?
�?           �?                                       �?
�? 历史记录   �?        主内容区                        �?
�? ──────── �?                                       �?
�? �?会议1   �?  ┌──────────────────────────────�?    �?
�? �?会议2   �?  �?                             �?    �?
�? �?会议3   �?  �?   [空状�? 点击开始录音]       �?    �?
�? ...       �?  �?                             �?    �?
�?           �?  └──────────────────────────────�?    �?
�?           �?                                       �?
�?           ├────────────────────────────────────────�?
�?           �? [声卡选择 ▼]    [●开始录音]  [■停止]   �?
└────────────┴────────────────────────────────────────�?
```

**空状态：** 默认显示空白 + 提示文字 + 开始按�?

**录音状态：** 显示录音动画（脉冲圆点）+ 实时转写文本�?+ 停止按钮

**设备选择�?* 下拉框列出所有音频输入设备，包括 USB Jabra

**历史记录�?* 左侧列表，点击加载历史会议纪要到主内容区

### 4.2 管理界面 (`/admin`)

当前管理界面�?Tab 组织�?
| Tab | 内容 |
|------|------|
| ASR 配置 | Provider、端点地址、API Key、Workspace ID、真实连接测�?|
| LLM 配置 | OpenAI 兼容 Base URL、API Key、模型名称、真实调用测�?|
| 邮件配置 | SMTP 主机、端口、账号、发件人、默认主题、签名、真实连接测�?|
| 提示词模�?| 模板列表、新增、编辑、停用、默认模板设�?|
| 热词管理 | 热词列表、新增、编辑、停用、删�?|
| 用户与权�?| 极简用户管理、固定角色分�?|
| 审计日志 | 最�?100 条关键操作记�?|

敏感配置只允许在后台侧读取和保存。普通录音页面不会通过 `/api/config` 获取 ASR API Key、Workspace ID 或真实上游鉴权信息�?
### 4.3 极简 RBAC 与审�?
一期只实现最小权限边界，不引入完整登录、组织架构或策略引擎�?
固定角色�?
| 角色 | 说明 |
|------|------|
| `user` | 普通用户，用于会议创建、查看、生成和发送 |
| `system_admin` | 管理员，可管理提示词模板、ASR 热词、系统配置、用户角色、审计日志和连接测试 |

当前开发阶段身份来源为 `getCurrentActor()` 中的 `admin` 用户，默认拥�?`system_admin`。后续接�?SSO 时替换身份来源即可，角色和审计表结构保持不变�?
后台 API 已增加轻量角色守卫：

| 范围 | 允许角色 |
|------|----------|
| `/api/admin/settings`、测试接口、用户、角色、审计日�?| `system_admin` |
| `/api/admin/prompt-templates`、`/api/admin/hotwords` | `system_admin` |

审计日志记录关键配置、模板、热词、用户、会议、LLM 生成和邮件发送动作。当前暂不做细粒度资源级授权，会议可见范围和真实登录态在后续身份接入任务中完善�?
---

## 5. 项目结构

```
meeting_asr_app/
├── docs/
�?  └── technical-design.md       # 本文�?
├── server/
�?  └── asr-gateway.mjs           # ASR Gateway，兼�?DashScope / Local FunASR
├── scripts/
�?  └── probe-service.mjs         # TCP/HTTP/WS 服务探测脚本
├── src/
�?  ├── app/
�?  �?  ├── layout.tsx            # 根布局
�?  �?  ├── page.tsx              # 主页�?
�?  �?  ├── admin/
�?  �?  �?  └── page.tsx          # 管理界面
�?  �?  └── api/
�?  �?      ├── config/
�?  �?      �?  └── route.ts      # 运行配置读取
�?  �?      └── summarize/
�?  �?          └── route.ts      # Qwen 摘要代理
�?  ├── components/
�?  �?  └── main/
�?  �?      ├── RecordingControls.tsx
�?  �?      ├── DeviceSelector.tsx
�?  �?      ├── TranscriptView.tsx
�?  �?      ├── HistoryList.tsx
�?  �?      └── HotWordManager.tsx
�?  ├── lib/
�?  �?  ├── admin-store.ts        # SQLite 后端存储、配置、会议、审计、极简 RBAC
�?  �?  ├── api-auth.ts           # 后台 API 轻量角色守卫
�?  �?  ├── funasr.ts             # 浏览器端 ASR 客户�?�?  �?  ├── voiceprint.ts         # 声纹特征提取与聚�?�?  �?  └── mockData.ts           # 管理页示例数�?�?  └── types/
�?      └── index.ts              # 类型定义
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── next.config.mjs
```

---

## 6. 核心流程

### 6.1 开始录�?

```
1. 用户点击"开始录�?
2. 检�?FunASR 服务连通性（WebSocket 握手测试�?
3. 调用 enumerateDevices() 刷新设备列表
4. 用户选择声卡（或使用默认设备�?
5. getUserMedia({ deviceId }) 打开麦克�?
6. 创建 AudioContext (16kHz) + AudioWorklet
7. 建立 FunASR WebSocket 连接，发送初始配�?
8. AudioWorklet 输出 PCM �?通过 WebSocket 发�?
9. 接收识别结果 �?实时渲染�?TranscriptView
10. 显示录音动画
```

### 6.2 停止录音

```
1. 用户点击"停止录音"
2. 关闭麦克风（track.stop()�?
3. 关闭 AudioContext
4. 发�?FunASR 结束信号（is_speaking: false�?
5. 等待最终识别结�?
6. 合并所有转写文本，按说话人分段
7. 调用 Qwen API 生成会议纪要
8. 保存�?SQLite
9. 刷新左侧历史记录列表
```

### 6.3 说话人识别流�?

```
FunASR 返回识别结果
  �?解析 stamp_sents 中的 spk ID
  �?查找本地 voiceprints 表，spk_id �?name
  �?未找到则显示�?发言�?X"
  �?用户可在管理界面中补充映�?
```

---

## 7. 待确认事�?

| # | 问题 | 影响 |
|---|------|------|
| 1 | FunASR 服务端是否已启用 CAM++ 说话人模型？ | 决定能否获取说话�?ID |
| 2 | 本地 FunASR 镜像的返回字段是否固定为 `text` / `text_2pass` / `is_final`�?| 影响代理结果映射 |
| 3 | 会议纪要输出格式偏好（Markdown / JSON）？ | 影响 LLM prompt 设计 |
| 4 | 是否需要支持离线模式（�?FunASR 时）�?| 影响功能范围 |
| 5 | 是否需要音频录制保存（本地�?wav 文件）？ | 影响存储设计 |

---

## 8. 依赖清单

### 8.1 npm 依赖

```json
{
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "funasr-client": "latest",
    "better-sqlite3": "^11.0.0",
    "zustand": "^4.0.0",
    "openai": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tailwindcss": "^3.0.0",
    "@types/node": "^20.0.0",
    "@types/react": "^18.0.0",
    "@types/better-sqlite3": "^7.0.0"
  }
}
```

### 8.2 shadcn/ui 组件（按需安装�?

- Button
- Select
- Input
- Textarea
- Card
- Table
- Dialog
- Badge
- ScrollArea
- Tabs

---

*文档版本: v1.1 | 更新时间: 2026-07-24*
