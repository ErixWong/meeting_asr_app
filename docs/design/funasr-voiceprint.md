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
funasr 容器内 Python 进程（FastAPI，独立端口，如 10097）
  ├─ POST /embedding    音频(PCM/WAV) → 192 维向量
  ├─ POST /register     说话人名 + 音频(≥2s) → 存入声纹库（均值向量）
  ├─ POST /identify     音频 → {speaker, score}（1:N 余弦匹配 + 阈值）
  └─ GET  /speakers     声纹库列表（增删）
```

- 声纹库存储：服务内 SQLite/JSON 文件即可（与主业务库解耦）；多段注册取 embedding 均值，支持按说话人聚合
- 阈值可调（默认 0.35，服务端配置化）
- 与现有 C++ ASR 服务的衔接：ASR 网关在 final 段回包时带上该句音频缓冲（当前前端已用 `extractAudioSegment` 切句），转发给声纹服务识别说话人——实现上可前端直连或经网关透传（待实现任务细化）

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

1. **phase 1**：新增声纹服务 + 注册管理界面（管理后台说话人库），前端 final 句可选调 `/identify` 获得人名
2. **phase 2**：前端启发式聚类降级为"服务不可用时的本地兜底"，声纹标注以服务端为准

## 4. 关键约束（踩坑记录）

1. **只用 CAM++，不用 ERES2NetV2**（#1438 OOM）；声纹进程**必须独立**于 ASR 全管线（#1808 内存不释放场景）
2. embedding 返回是 `(1, 192)` Tensor，取 `[0]` 转 numpy；勿按 `len()` 判断维度
3. 短句（<1s）/音色相近说话人区分度下降（GitHub issue #2944 官方说明）→ 识别接口对过短音频应返回低置信度或要求更长注册音频（≥2s）
4. 模型放宿主挂载 `/docker/funasr/models/iic/...`，容器重建后无需重新下载（首次可脚本预下载）
5. `spk_model` 输出的是"全量离线聚类"的 spk 标签；**逐句实时识别走 embedding 提取 + 1:N 匹配**，二者不要混用

## 5. 相关文档

- 任务与调研笔记：`~/tasks/funasr-voiceprint/`（research/01 容器盘点、02 网络验证、03 本地实测）
- 模型选型背景：`docs/funasr-models.md` §4.6（服务端声纹支持说明）
- 前端现状：`src/lib/voiceprint.ts`；UI 声纹管理设计：`docs/ui-interaction-design.md` §4.5
