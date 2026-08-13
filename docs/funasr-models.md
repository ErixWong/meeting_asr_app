# FunASR 模型说明与选型指南

> 本文说明 FunASR 各模型的语种能力、与本系统的部署关系及选型建议。
> 配套文档：[部署指南](./funasr-deployment.md)、[迁移说明](./funasr-migration.md)。

## 1. 核心概念：模型即语种

FunASR 中**语种能力由模型决定**，模型在服务启动时通过 `--model-dir` 静态加载，运行中不可更换。不存在独立的"语言切换"接口；所谓"切换语种"，本质是：

- 换用覆盖目标语种的模型（静态，需改启动命令重启），或
- 在**多语种模型**内通过会话参数指定解码语种（动态，如 SenseVoice 的 `svs_lang`）

Python SDK 侧对应 `AutoModel(model="...")` 的 `model` 参数，模型不同，语种支持不同。

## 2. 候选模型一览

| 模型 | 语种 | 流式 | 热词 | 大小（ONNX 量化） | 备注 |
|---|---|---|---|---|---|
| Paraformer-large 中文 | 中文（英文混排） | ✅ 2pass（在线+离线） | ✅ ngram/WFST | 约 227 MB | 本系统当前部署 |
| Paraformer-large 英文 | 英文 | ❌ 仅离线 | ✅ ngram/WFST | 约 231 MB | 无官方 streaming 版 |
| SenseVoiceSmall | 中/英/日/韩/粤 | ❌ 仅离线 | ❌ | 约 230 MB | 支持 `svs_lang` 指定语种，带情感/事件标签 |
| Fun-ASR-Nano | 中/英/日+中文方言 | ❌（GPU，vLLM） | ❌ | 800M 参数（bf16 约 1.6 GB） | 新旗舰，需 GPU，未评估 |
| Fun-ASR-MLT-Nano | 31 语种 | ❌ | ❌ | 800M 参数（bf16 约 1.6 GB） | 多语种旗舰，需 GPU，未评估 |

> 大小说明：
> - ONNX 量化为服务实际加载的 `model_quant.onnx` 文件体积（ModelScope 仓库实测）
> - 完整部署占用不止模型权重：中文 Paraformer 还需在线模型（约 227 MB）+ VAD（约 5 MB）+ 标点 + ngram 语言模型（TLG.fst 约 915 MB），全套约 2.5~3 GB；SenseVoice 方案无在线模型与 ngram，全套约 0.5 GB（SenseVoice + VAD + 标点 + ITN）

> Fun-ASR-Nano / MLT-Nano 属新旗舰模型，需要 GPU（vLLM），当前 CPU 容器方案不适用，仅记录备选。

### 2.1 Paraformer-large 中文（当前部署）

- 模型 ID：`damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx`
- 在线模型：`damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx`
- 架构：2pass = 在线流式模型实时输出半字级 partial（`transcript.partial`）+ 离线模型句尾纠错（`transcript.final`）
- 中文 CER：约 10.18%；CPU 约 15x 实时
- 特点：**实时滚动字幕体验最佳**，支持 ngram/WFST 热词（`--lm-dir`），无语种参数，纯英文识别能力弱

### 2.2 Paraformer-large 英文

- 模型 ID：`damo/speech_paraformer-large_asr_nat-en-16k-common-vocab10020-onnx`
- 官方**未发布英文 streaming/online 模型**，因此只有离线文件转录服务（`funasr-wss-server`，offline 协议），没有 2pass 版
- 与本系统不兼容：本项目客户端走 2pass 流式协议，offline 模式需要重写客户端适配，成本高

### 2.3 SenseVoiceSmall

- 模型 ID：`iic/SenseVoiceSmall-onnx`
- 语种：中/英/日/韩/粤，可经 `svs_lang` 指定（`auto`/`zh`/`en`/`ja`/`ko`/`yue`）或逐句自动检测
- 架构：纯离线模型（2pass-offline 模式），无流式 partial，出结果更晚
- 中文 CER：约 7.81%（优于 Paraformer-large）；CPU 约 17x 实时；单模型 234M
- 不支持 ngram 热词；输出带 `<|zh|><|NEUTRAL|><|Speech|>` 语言/情感/事件标签，可能需要过滤

## 3. 本系统当前部署

### 3.1 部署形态

- 镜像：`funasr-runtime-sdk-online-cpu-0.1.13`
- 二进制：`funasr-wss-server-2pass`（中文 Paraformer 2pass）
- 启动命令（默认，不显式指定模型）：

```text
funasr-wss-server-2pass --download-model-dir /workspace/models --certfile 0 --port 10095
```

- 语种：固定中文（混排英文），前端无模型/语种选择
- 当前状态：生产部署已切换为方案 A（SenseVoiceSmall，见 4.2），本节描述镜像默认形态

### 3.2 模型目录现状（/docker/funasr/models）

| 模型 | 用途 | 状态 |
|---|---|---|
| `speech_fsmn_vad_zh-cn-16k-common-onnx` | VAD 端点检测 | ✅ |
| `speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx` | 离线 ASR | ✅ |
| `speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx` | 在线流式 ASR | ✅ |
| `punc_ct-transformer_zh-cn-common-vad_realtime-vocab272727-onnx` | 中文标点 | ✅ |
| `punc_ct-transformer_cn-en-common-vocab471067-large-onnx` | 中英大标点 | ✅（可选替代） |
| `speech_ngram_lm_zh-cn-ai-wesp-fst` | ngram 热词 | ✅ |
| `thuduj12/fst_itn_zh` | ITN 数字归一化 | ✅ 已补齐（部署在 `thuduj12/` 子目录） |

> ITN 缺失影响：数字/日期/金额输出中文数字形式（如"二零二四年"而非"2024年"）。补齐方法见下文 4.1 的 `--itn-dir` 参数及注意项。

## 4. 部署方案与 docker-compose 命令

> 统一说明：
> - 镜像固定为 `registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13`，挂载 `<宿主机模型目录>:/workspace/models`
> - 以下只给出 `command` 部分；完整 compose（ports/volumes/healthcheck 等）与上述镜像一致，参见 [funasr-deployment.md](./funasr-deployment.md) 第 3 节
> - `--download-model-dir /workspace/models` 为模型下载/本地查找根目录；所有 `--xxx-dir` 参数接受 **ModelScope 模型 ID**（`damo/...`、`iic/...`、`thuduj12/...`），首次启动自动下载到该目录，已存在则直接加载

### 4.1 现状方案：中文 Paraformer 2pass（默认）

不指定任何模型参数时即为此配置（镜像内置默认），也可显式指定：

```yaml
    command: >
      /workspace/FunASR/runtime/websocket/build/bin/funasr-wss-server-2pass
      --download-model-dir /workspace/models
      --vad-dir damo/speech_fsmn_vad_zh-cn-16k-common-onnx
      --model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx
      --online-model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx
      --punc-dir damo/punc_ct-transformer_cn-en-common-vocab471067-large-onnx
      --itn-dir thuduj12/fst_itn_zh
      --certfile 0
      --port 10095
```

- 流式：✅ 2pass（在线模型出 partial，离线模型句尾纠错）
- 语种：固定中文（英文混排）；前端 `svs_lang` 参数不生效
- 热词：✅ 支持 ngram/WFST（如需启用可加 `--lm-dir damo/speech_ngram_lm_zh-cn-ai-wesp-fst`）
- 注意：不传 `--online-model-dir` / `--lm-dir` 时服务使用二进制内置默认值（即 Paraformer 在线模型与中文 ngram），效果等同于显式指定

### 4.2 方案 A：SenseVoiceSmall 单实例多语种（已验证部署成功）

```yaml
    command: >
      /workspace/FunASR/runtime/websocket/build/bin/funasr-wss-server-2pass
      --download-model-dir /workspace/models
      --vad-dir damo/speech_fsmn_vad_zh-cn-16k-common-onnx
      --model-dir iic/SenseVoiceSmall-onnx
      --punc-dir damo/punc_ct-transformer_cn-en-common-vocab471067-large-onnx
      --itn-dir thuduj12/fst_itn_zh
      --certfile 0
      --port 10095
```

- 语种：中/英/日/韩/粤，前端 `svs_lang` 参数生效（`auto`/`zh`/`en`/`ja`/`ko`/`yue`）
- 架构：2pass-offline（纯离线），无流式 partial，实时滚动体验变差
- 热词：❌ 不支持 ngram（`--lm-dir` 不适用，勿加）
- 注意：不传 `--online-model-dir` 时服务仍会打印/加载内置默认的 Paraformer 在线模型，但 SenseVoice 推理不会走它，属正常现象

### 4.3 方案 B：英文 Paraformer 离线实例（不推荐）

英文 Paraformer 无 streaming 版，仅离线，需换二进制 `funasr-wss-server`（offline 协议，与本系统 2pass 客户端不兼容）：

```yaml
    command: >
      /workspace/FunASR/runtime/websocket/build/bin/funasr-wss-server
      --download-model-dir /workspace/models
      --vad-dir damo/speech_fsmn_vad_zh-cn-16k-common-onnx
      --model-dir damo/speech_paraformer-large_asr_nat-en-16k-common-vocab10020-onnx
      --punc-dir damo/punc_ct-transformer_cn-en-common-vocab471067-large-onnx
      --certfile 0
      --port 10095
```

### 4.4 方案 C：双实例按语种路由（中文流式 + 英文可用）

Paraformer 中文实例（10095）+ SenseVoiceSmall 实例（10096），两个容器分别使用 4.1 与 4.2 的命令（端口与容器名不同），并在 Gateway 侧按 `session.svsLang` 路由：

```text
前端 svsLang=zh → Gateway → Paraformer 中文实例 (10095)
前端 svsLang=en → Gateway → SenseVoice 实例 (10096)
```

所需配套改造（尚未实现）：`server/asr-gateway.mjs` 的 `createProviderAdapter` 支持按 `svsLang` 选择 `targetWsUrl`；后台 ASR 配置支持双 endpoint。

### 4.5 ITN 参数注意项（踩坑记录）

- `--itn-dir` **只接受相对路径（ModelScope 模型 ID 写法）**：服务内部用 `--download-model-dir + --itn-dir` 拼接本地路径，传绝对路径会双重拼接导致找不到，且会被当成远程模型 ID 查询报 `does not exist`
- 正确写法：`--itn-dir thuduj12/fst_itn_zh`（模型下载后位于 `/workspace/models/thuduj12/fst_itn_zh/`）
- ITN 对 Paraformer 与 SenseVoice 均适用；缺失时服务可正常启动，仅数字/日期不做归一化

### 4.6 声纹（说话人）支持说明

**先纠正一个常见误区**：声纹（说话人识别/分离）不是 ASR 模型的能力，而是独立的说话人模型（CAM++ / ERES2NetV2 等），与 ASR 模型正交。

**C++ 2pass 服务（4.1/4.2，即本系统当前部署形态）不支持服务端声纹**——`funasr-wss-server-2pass`（镜像 0.1.13）的参数列表（源码 `runtime/websocket/bin/funasr-wss-server-2pass.cpp` 确认）没有 `--enable-spk` / `--spk-model`，服务端不会输出 `speaker_id`。

**本系统声纹方案（与部署解耦）**：前端自实现——`src/app/page.tsx` 在 `transcript.final` 时用 `extractAudioSegment` 切出该句音频，本地提取声纹特征（`extractFeatures`）并聚类（`clusterSpeakers`）分配说话人。因此无论部署 Paraformer 还是 SenseVoice，现有说话人功能不受影响，**无需在服务端启用声纹**。

> **2026-08 已验证的服务端声纹路径**（调研 + 容器实测）：现有 funasr 容器内可直接运行 CAM++（`iic/speech_campplus_sv_zh-cn_16k-common`，26.7MB/192 维/CPU 单句 ~110ms），支持注册制 1:N 说话人识别，作为前端启发式聚类的升级路径。详细结论与设计约束见 [docs/design/funasr-voiceprint.md](./design/funasr-voiceprint.md)。

**如需服务端声纹**（仅 Python 服务支持）：

| 服务 | 启用方式 | 备注 |
|---|---|---|
| Fun-ASR-Nano 实时 WS 服务（`serve_realtime_ws.py`） | `--enable-spk --spk-model iic/speech_eres2netv2_sv_zh-cn_16k-common` | 官方提示 Nano 上声纹效果有限、每句全量重聚类 O(N²) 开销大，默认关闭 |
| Fun-ASR-Nano 离线服务（`serve_vllm.py`） | HTTP 参数 `spk=true` | |
| Python SDK 离线批处理 | `AutoModel(model=..., spk_model="cam++")` | 通用做法 |

### 对比汇总

| 维度 | 现状（Paraformer 中文） | 方案 A（SenseVoice） | 方案 C（双实例） |
|---|---|---|---|
| 中文流式 partial | ✅ | ❌ | ✅ |
| 英文识别 | ❌ | ✅ | ✅ |
| 语种切换 | 无 | `svs_lang` | `svs_lang` 路由 |
| 热词 | ✅ ngram | ❌ | 中文实例 ✅ |
| 部署复杂度 | 1 容器 | 1 容器 | 2 容器 + Gateway 改造 |
| 实时性 | 最佳 | 变差 | 中文最佳/英文一般 |

## 5. 前端语种参数（svs_lang）

本系统已实现录音/上传的语言选项（默认 `auto`）：

```
前端页面(语种下拉框: auto/zh/en/ja/ko/yue)
  → session.start.svsLang  (src/lib/funasr.ts)
  → ASR Gateway 透传       (server/asr-gateway.mjs: buildLocalFunasrStartMessage → svs_lang)
  → FunASR 服务端按语种解码
```

**重要**：`svs_lang` 是模型内会话参数，不是模型路由器。只有服务端为 SenseVoiceSmall（方案 A/C）时生效；Paraformer 部署下该参数被忽略（自动行为）。

## 6. 结论与建议

1. **以中文为主、看重实时滚动字幕**：维持现状（Paraformer 中文 2pass，4.1），前端语言选项保持 auto，不启用 svs_lang
2. **需要中英文切换、可接受实时性下降**：方案 A（SenseVoiceSmall，4.2）——**已实际部署验证成功**（含 ITN），前端 `svs_lang` 已就绪，仅需服务端换模型
3. **中文流式与英文兼顾**：方案 C（双实例路由，4.4），需先扩展 Gateway 与后台 ASR 配置结构
4. 英文 Paraformer（方案 B，4.3）因无流式版、协议不兼容，不纳入选型

## 7. 离线与流式：概念与本系统处理

### 7.1 概念

| | 离线识别（offline） | 流式识别（streaming/online） |
|---|---|---|
| 输入 | 等完整音频后再推理 | 边收音频边增量推理 |
| 输出 | 一次性给出最终结果 | 半字级中间结果（partial），随说话推进持续刷新 |
| 延迟 | 高（整句/整段结束才出） | 低（边说边出） |
| 精度 | 高（上下文完整） | 早期结果可能被后续修正 |
| 协议消息 | `transcript.final` | `transcript.partial` + 句尾 `transcript.final` |

**2pass = 两者结合**：在线模型边收边出 `transcript.partial`（实时滚动字幕），一句话说完由离线模型重算整句、输出修正后的 `transcript.final`（句尾纠错）。Paraformer 中文正是这种形态。

SenseVoiceSmall 只有离线模型，以 **2pass-offline** 模式运行：没有在线通道，不产生 partial，每句识别完成后直接出 final。

### 7.2 本系统如何处理

完整链路：

```
浏览器录音
  → WebSocket 会话 (src/lib/funasr.ts)
  → ASR Gateway (server/asr-gateway.mjs)
  → FunASR 服务端（2pass / 2pass-offline）
  → 结果回传：transcript.partial / transcript.final
```

**① Gateway 判定**（`server/asr-gateway.mjs:179` `parseLocalFunasrTranscript`）：

- 文本取值优先级：`text` → `text_2pass`（2pass 句尾纠错结果）→ `asr_result`
- `isFinal = is_final || is_eof || mode 含 offline`
- 关键：**SenseVoice 部署下 mode 恒为 offline（2pass-offline），所有结果一律判定为 final**，天然没有 partial

**② 前端客户端**（`src/lib/funasr.ts`）：

- `transcript.partial` → `isFinal=false`，仅刷新实时字幕
- `transcript.final` → `isFinal=true`，提交最终段；并用 `beginTime/endTime` 从本地音频缓冲切出该句音频段（`extractAudioSegment`），供声纹特征提取与说话人聚类（`page.tsx` 中仅 final 触发）

**③ 页面渲染**（`src/app/page.tsx`）：

- partial 走节流合并（`PARTIAL_RENDER_INTERVAL_MS` + `pendingPartialRef`），避免高频 partial 造成闪烁
- final 才落最终段、触发声纹/说话人处理

### 7.3 对两种部署的实际影响

| | Paraformer 中文 2pass | SenseVoice 2pass-offline |
|---|---|---|
| partial 实时滚动 | ✅ 有 | ❌ 无（mode=offline 全判 final） |
| 出结果时机 | 边说边出 | 每句完整结束才出 |
| 页面体验 | 实时滚动字幕 | 逐句跳出 |
| 声纹/说话人 | final 触发（正常） | final 触发（正常） |

结论：本系统的 partial/final 双通道、节流渲染、final 驱动声纹等机制对两种部署**代码上均兼容**（无需改动）；差异仅在 SenseVoice 下 partial 通道为空、实时滚动体验降级为逐句输出。✌Bazinga！
