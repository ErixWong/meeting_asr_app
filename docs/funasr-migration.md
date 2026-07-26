# FunASR 迁移说明

## 1. 背景

项目最初接入的是阿里云 DashScope 提供的云端 FunASR 服务。前端录音逻辑、生命周期事件和鉴权方式都默认建立在 DashScope 协议之上。

当前项目已调整为优先接入本地部署的 FunASR WebSocket 服务，同时保留原有阿里云路径作为兼容兜底。

本次迁移不是简单的地址替换，而是一次协议接入层迁移。

## 2. 迁移目标

迁移到本地 FunASR 的主要目标如下：

1. 语音数据留在内网或本地环境，降低公网传输和数据合规压力。
2. 上游 ASR 服务由自有容器控制，便于排障、升级模型和统一运维。
3. 降低对阿里云 `workspaceId`、鉴权和公网可达性的依赖。
4. 为后续热词、说话人模型和领域词表优化预留更高控制权。

## 3. 两种接入方式的核心差异

### 3.1 连接方式

阿里云 DashScope FunASR：

- 通过 `FUNASR_WORKSPACE_ID` 拼接上游地址
- 典型地址格式：`wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`

本地 FunASR：

- 通过显式地址连接
- 典型地址格式：`ws://host:10095/ws`
- 当前项目通过 `FUNASR_SERVER_WS_URL` 配置，例如：`http://hp.inteva.vip:10095`
- 代理会自动规范化为 `ws://hp.inteva.vip:10095/ws`

### 3.2 鉴权方式

阿里云 DashScope FunASR：

- 需要 `DASHSCOPE_API_KEY`
- 连接时需要 `Authorization: Bearer <apiKey>`

本地 FunASR：

- 当前接入方式不依赖阿里云鉴权头
- 认证方式取决于本地服务自身实现，这次接入的服务无需额外鉴权头

### 3.3 协议格式

阿里云 DashScope FunASR：

- 使用 DashScope 风格协议
- 前端发送 `run-task`
- 上游返回 `task-started`
- 识别结果通过 `result-generated`
- 结束时发送 `finish-task`

本地 FunASR：

- 使用原生 2pass WebSocket 协议
- 初始化首包更接近：

```json
{
  "mode": "2pass",
  "chunk_size": [5, 10, 5],
  "chunk_interval": 10,
  "audio_fs": 16000,
  "wav_format": "pcm",
  "wav_name": "meeting-id",
  "is_speaking": true,
  "itn": true,
  "hotwords": "项目名 缩写 术语",
  "svs_lang": "auto",
  "svs_itn": true
}
```

- 停止时更接近发送：

```json
{
  "is_speaking": false,
  "is_eof": true,
  "wav_name": "meeting-id"
}
```

### 3.4 返回结果格式

阿里云 DashScope FunASR：

- 结果包装在 `header` 和 `payload.output.sentence` 中
- 前端原始逻辑按 `task-started`、`result-generated`、`task-finished` 消费

本地 FunASR：

- 返回字段更接近 `text`、`text_2pass`、`is_final`
- 不一定返回 `task-started`
- 不一定返回 DashScope 风格的事件结构

### 3.5 运维责任

阿里云 DashScope FunASR：

- 云端托管
- 主要关注 API Key、workspace、网络可达性和额度

本地 FunASR：

- 需要自行管理容器、镜像、端口、防火墙和模型加载
- 出问题时需要排查 TCP、WebSocket、协议首包和服务端日志

## 4. 迁移过程中遇到的实际问题

### 4.1 地址不是直接可用的 HTTP 地址

最初提供的是：

```text
http://hp.inteva.vip:10095
```

但录音链路需要的是 WebSocket 端点，而不是普通 HTTP 地址。实际可用路径为：

```text
ws://hp.inteva.vip:10095/ws
```

因此代理层增加了地址规范化逻辑，把 `http://host:10095` 自动转成 `ws://host:10095/ws`。

### 4.2 端口早期不可达

最初排查时，本地机器访问目标地址返回：

- `ECONNREFUSED 10.41.24.109:10095`
- `curl` 无法连通
- TCP 连接失败

这说明问题并不在前端，而在服务端端口尚未监听或网络不可达。

### 4.3 服务恢复后，WebSocket 可握手但录音仍无结果

容器重启后重新探测，确认：

- TCP 可连接
- HTTP 返回 `426`
- WebSocket 握手成功

这说明服务本身已经是 WebSocket 服务，但仅靠“能连上”还不够，协议仍然需要匹配。

### 4.4 DashScope 风格首包无法驱动本地 FunASR 返回结果

前端原始逻辑发送的首包是 DashScope 风格 `run-task`。服务端日志显示能够收到该消息，但前端始终等不到 `task-started`，也没有识别文本返回。

根因是：

- 本地 FunASR 接受 WebSocket 连接
- 但它不按 DashScope 协议工作
- 它需要原生 2pass 初始化报文，而不是透传 `run-task`

### 4.5 页面配置状态会短暂不同步

前端首次渲染时，`/api/config` 还未回填，导致点击录音时可能错误提示：

```text
请先在 .env.local 中配置 FUNASR_SERVER_WS_URL，或配置 DASHSCOPE_API_KEY 和 FUNASR_WORKSPACE_ID
```

因此前端增加了录音前的运行时配置兜底刷新。

## 5. 当前采用的解决方案

### 5.1 保持前端录音逻辑尽量不变

浏览器仍然只连接：

```text
ws://localhost:8080
```

这样 `src/lib/funasr.ts` 无需直接理解本地 FunASR 的全部原生协议细节。

### 5.2 在本地代理层做协议兼容

当前在 `server/proxy.mjs` 中完成以下兼容：

1. 优先读取 `FUNASR_SERVER_WS_URL`
2. 自动把 `http://...` 转为 `ws://.../ws`
3. 本地模式下不再发送 DashScope `Authorization` 头
4. 收到前端 `run-task` 后，转换为原生 FunASR 2pass 初始化 JSON
5. 收到前端 `finish-task` 后，转换为 `is_speaking: false` 和 `is_eof: true`
6. 向前端合成 `task-started`
7. 在合适时机向前端合成 `task-finished`
8. 将本地 FunASR 返回结果重新包装为前端可消费的 `result-generated`

### 5.3 前端配置检查放宽

当前前端逻辑已经调整为：

- 如果存在 `FUNASR_SERVER_WS_URL`，允许直接开始录音
- 不再强依赖阿里云 `DASHSCOPE_API_KEY` 和 `FUNASR_WORKSPACE_ID`
- 录音前会按需重新获取 `/api/config`

## 6. 代码层面的实际修改

### 6.1 `server/proxy.mjs`

主要修改：

- 增加 `FUNASR_SERVER_WS_URL`
- 地址规范化逻辑
- 本地模式与云端模式分支
- `run-task` 到 2pass 初始化首包的转换
- `finish-task` 到 `is_speaking: false` 的转换
- 本地 FunASR 返回消息到 DashScope 风格结果的重包装

### 6.2 `src/app/api/config/route.ts`

新增：

- `hasCustomFunasr`

用于前端判断当前是否存在本地 FunASR 配置。

### 6.3 `src/app/page.tsx`

主要修改：

- 增加运行时配置加载函数
- 页面初始化时加载 `/api/config`
- 点击录音前按需重新拉取配置
- 存在 `FUNASR_SERVER_WS_URL` 时跳过阿里云凭证校验

### 6.4 `package.json`

开发脚本由：

```json
"dev": "node server/proxy.mjs & next dev"
```

调整为：

```json
"dev": "concurrently \"node server/proxy.mjs\" \"next dev\""
```

原因是 Windows PowerShell 下原先写法无法稳定并发启动代理和 Next。

### 6.5 `scripts/probe-service.mjs`

新增服务探测脚本，用于判断目标地址：

- 是否 TCP 可达
- 是否为 HTTP 服务
- 是否支持 WebSocket 握手
- 是否支持 TLS / WSS

用于快速区分“连不上服务”和“协议不匹配”。

## 7. 当前结论

本次迁移证明：

1. 阿里云 DashScope FunASR 和本地 FunASR 不是简单的同构服务，协议层存在实际差异。
2. 项目若直接把云端地址替换成本地地址，通常无法工作。
3. 对当前项目来说，最稳妥的方案是保留前端录音接口不变，在代理层做协议翻译。
4. 这种改法能把迁移影响控制在服务接入层，而不是扩散到所有前端状态和录音逻辑。

## 8. 后续建议

1. 继续观察本地 FunASR 实际返回字段是否在不同镜像版本之间变化。
2. 将管理页中的 FunASR 配置卡片真正接到运行配置，而不仅是 UI 占位。
3. 如果后续完全弃用阿里云路径，可以进一步清理 DashScope 兼容逻辑。
4. 若要做更强鲁棒性，可把本地 FunASR 的协议字段抽成独立适配器模块，避免 `server/proxy.mjs` 继续膨胀。