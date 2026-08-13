# FunASR 服务端声纹（说话人识别）方案：可行性验证与设计约束

> 任务 `funasr-voiceprint` 沉淀（2026-08-13，网络检索 + 容器内实测双向验证）。目标：确定服务端声纹方案，作为前端启发式聚类（`src/lib/voiceprint.ts`）的升级/替代路径，支持注册制说话人识别（1:N）。

## 1. 结论速览

- ✅ **可行**：现有 FunASR 容器（`funasr-online-sense`，镜像 `funasr-runtime-sdk-online-cpu-0.1.13`）内已带 Python SDK（funasr 1.1.12 + modelscope + torch 2.2.1+cpu），**无需新镜像**即可运行声纹服务
- ✅ **模型选定 CAM++**（`iic/speech_campplus_sv_zh-cn_16k-common`）：26.7MB / 7.2M 参数 / 192 维 embedding / CPU RTF 0.02~0.04 / 运行内存 448MB 稳定
- ⛔ **不选 ERES2NetV2**：GitHub modelscope issue #1438 确认多次调用内存溢出（OOM）
- ✅ **内存稳定**：CAM++ 独立使用实测 30 次连续调用零增长；#1808（完整 ASR 管线内存不释放）为全管线场景 → 声纹必须独立进程
- ✅ **注册制识别验证**：同一编码器提取 embedding + 余弦相似度 + 阈值；实测同人 0.69 vs 异人 ~0.0，阈值 0.3~0.4 可靠区分

## 2. 实测证据（容器内，2026-08-13）

| 项 | 结果 |
|---|---|
| 单句 embedding 提取耗时（~3s 音频） | **103~113ms**（RTF 0.02~0.04，25~50 倍实时） |
| 模型加载耗时 | 首次 4.4s / 本地路径 2.2s |
| 返回结构 | `res[0]["spk_embedding"]` → `torch.Tensor (1, 192)` |
| 模型持久化 | `/docker/funasr/models/iic/speech_campplus_sv_zh-cn_16k-common`（宿主挂载，重建不丢） |
| GPU | 不需要（CPU 推理，不影响 llama.cpp 显存占用） |

示例音频（官方自带 speaker1_a/b、speaker2_a）相似度：同人 0.6936，异人 -0.0842 / 0.0072。

## 3. 设计决策

### 3.1 服务形态：独立声纹服务（embedding 提取 API + 注册制识别）

与 ASR **逻辑隔离、单独服务**（沿用前期结论）。服务端声纹管线为：

```
funasr 容器内 Python 进程（deploy/voiceprint/voiceprint-server.py，端口 10097）
  ├─ GET  /health        健康检查 + 状态（模型加载/说话人数/阈值）
  ├─ POST /embedding     音频(PCM/WAV) → 192 维向量
  ├─ POST /register      说话人名 + 音频(≥0.2s) → 存入声纹库（均值向量）
  ├─ POST /identify      音频 → {matched, speaker, score, top}（1:N 余弦匹配 + 阈值）
  ├─ GET/DELETE /speakers    声纹库列表 / 删除
  └─ GET/PUT /config     阈值查询 / 更新
```

- **技术选型**：容器内无 fastapi/uvicorn → 用 Python 标准库 `http.server.ThreadingHTTPServer` 实现（零额外依赖），仅依赖 numpy + torch/torchaudio（重采样）+ funasr（镜像自带）
- 声纹库存储：服务内 SQLite（`deploy/voiceprint/data/voiceprints.db`，WAL 模式，与主业务库解耦）；多段注册取 embedding 均值并归一化（单位向量，余弦=点积）
- 阈值可调（默认 0.35，服务端 SQLite 持久化 + 管理后台可改）
- 模型调用加 `threading.Lock` 串行推理，`ThreadingHTTPServer` 支撑并发请求
- 音频输入：完整 WAV（任意采样率/声道，自动重采样 16k 单声道）或裸 s16le PCM + sample_rate

### 3.2 部署形态：独立容器（推荐） / 同容器多进程（备选）

| 维度 | 独立容器（推荐） | 同容器多进程（funasr-online-sense 内） |
|---|---|---|
| 隔离性 | 好：独立生命周期、独立重启/升级 | 差：与 C++ 服务同生共死，需改 entrypoint（supervisord） |
| 镜像 | 复用 `funasr-runtime-sdk-online-cpu-0.1.13`（python 环境已带） | 复用现有容器 |
| 模型目录 | 共享宿主挂载 `/docker/funasr/models` | 共享宿主挂载 |
| 资源 | CPU ~0.5GB 内存，36 核富余 | 同左 |
| 风险 | 无 | 若 ASR 服务崩溃/重启，声纹进程也受影响 |

### 3.3 前端衔接（升级路径）

现状：`src/lib/voiceprint.ts` 12 维启发式特征聚类（仅分离不识别）。
升级路径（不破坏现有功能）：

1. **phase 1**（已完成）：独立声纹服务（`deploy/voiceprint/`）已部署运行，端口 10097，注册制 1:N 识别实测通过
2. **phase 2**（已完成）：主应用接入——final 句异步调 `/identify`，命中人名覆盖段 speaker 字段（前端聚类保留为兜底）；服务不可用 → 30s 冷却静默降级，录音主流程零影响
3. **phase 3**（已完成）：admin 后台「声纹管理」tab（`src/components/admin/VoiceprintPanel.tsx`）——启停/端点/阈值配置、连通性测试、录音/上传注册、列表/删除
4. **phase 4**（远期）：音频持久化 + 离线重识别、置信度 UI（数据库当前只存文本不存音频）

## 4. 实现落地（2026-08-13）

### 4.1 文件清单

| 文件 | 职责 |
|---|---|
| `deploy/voiceprint/voiceprint-server.py` | 声纹服务（纯 stdlib HTTP + CAM++ + SQLite） |
| `deploy/voiceprint/docker-compose.yml` | 独立容器编排（复用 funasr-runtime-sdk 镜像、端口 10097、共享模型挂载、1G 内存上限） |
| `src/lib/voiceprint-server.ts` | 服务端代理（读 app_settings 端点、5s 超时、不可达抛 VoiceprintUnavailableError） |
| `src/lib/voiceprint-audio.ts` | 客户端 Float32Array(base64) → int16 PCM base64 转换 |
| `src/app/api/voiceprint/{identify,register,speakers,config}/route.ts` | API 代理路由（identify=登录用户；register/speakers 增删/config PUT=admin） |
| `src/lib/voiceprint-api.ts` | 浏览器端封装（identify/register/delete/config/speakers） |
| `src/components/admin/VoiceprintPanel.tsx` | admin「声纹管理」tab 组件 |
| `src/app/page.tsx` | 录音 onResult：final 段提交后异步 identify，命中人名更新段 speaker |
| `src/components/main/TranscriptView.tsx` | 段显示：优先 speaker 人名，无则回退“说话人 N” |
| `src/lib/admin-store.ts` | app_settings 增加 `voiceprint:enabled` / `voiceprint:endpoint` 定义与默认值 |

### 4.2 数据流

```
浏览器（Float32Array 16k）→ POST /api/voiceprint/identify → int16 PCM base64
→ funasr-voiceprint:10097 /identify → CAM++ embedding(192) → SQLite 1:N 余弦 + 阈值
→ {matched, speaker, score} → 命中则 setLiveSegments 更新段 speaker 字段（随会议记录持久化）
```

### 4.3 验证结果（全链路，2026-08-13）

- 服务 API：注册/识别/阈值调整/删除/错误处理全部通过（同人 0.69~1.0 vs 异人 -0.08~0.01）
- 代理路由：admin 全可用；普通用户 identify 200、register/speakers 403 Forbidden；未登录 401
- 降级保障：停容器后 identify 返回 503、config 报不可达；容器重启后自动恢复（health 检查通过后 ready）
- 多段均值注册效果：张三追加 speaker1_b 后识别分数 0.69 → 0.80（均值更稳）
- TypeScript 编译 + `next build` 通过；4 个 voiceprint API 路由进入构建产物

## 5. 关键约束（踩坑记录）

1. **只用 CAM++，不用 ERES2NetV2**（#1438 OOM）；声纹进程**必须独立**于 ASR 全管线（#1808 内存不释放场景）
2. embedding 返回是 `(1, 192)` Tensor，取 `[0]` 转 numpy；勿按 `len()` 判断维度
3. 短句（<1s）/音色相近说话人区分度下降（GitHub issue #2944 官方说明）→ 识别接口对过短音频应返回低置信度或要求更长注册音频（≥2s）
4. 模型放宿主挂载 `/docker/funasr/models/iic/...`，容器重建后无需重新下载（首次可脚本预下载）
5. `spk_model` 输出的是"全量离线聚类"的 spk 标签；**逐句实时识别走 embedding 提取 + 1:N 匹配**，二者不要混用

## 6. 相关文档

- 任务与调研笔记：`~/tasks/funasr-voiceprint/`（research/01 容器盘点、02 网络验证、03 本地实测）
- 模型选型背景：`docs/funasr-models.md` §4.6（服务端声纹支持说明）
- 前端现状：`src/lib/voiceprint.ts`；UI 声纹管理设计：`docs/ui-interaction-design.md` §4.5
