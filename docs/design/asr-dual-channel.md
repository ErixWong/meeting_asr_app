# 双路 ASR 转写：来源契约与状态机约束

> 任务 `feat-260806-01-dual-channel-asr-view` 沉淀。定义多路采集（mic 多设备 + speaker）下转写段的数据契约与前端状态机约束，后续多路功能均依赖本约定。

## 1. 转写段来源契约

`TranscriptSegment`（前后端 + 存储 JSON 三方共享）：

```ts
interface TranscriptSegment {
  id: string;
  speaker: string;
  speakerId?: number | null;
  source?: "mic" | "speaker";   // 采集类型；缺省视为 mic（历史数据）
  deviceId?: string;             // mic 路的具体设备 id；speaker 路为 undefined
  text: string;
  time: string;
  timeSeconds: number;
  isFinal: boolean;
}
```

- `source` 语义：**采集通道类型**，非说话人身份；说话人分离由 `speakerId` 表达
- 多麦克风时每路一个 `FunASRClient` + 一个网关会话，用 `deviceId` 区分；`source` 只区分 mic/speaker 两类

## 2. 存储链路

- **写入**：`meeting_asr_results.raw_payload` 原样 JSON 序列化（create/append 均透传，无字段过滤）
- **读取**：`parseTranscriptSegments`（admin-store）为白名单归一化，**必须显式保留 `source`/`deviceId`**，新增转写段字段时必须同步扩展该白名单，否则历史详情/列表会静默丢字段
- 纪要输入 `inputTranscriptSnapshot` 基于 `normalized_text`（纯文本拼接），与来源字段无关，双路全文天然入纪要

## 3. 前端状态机约束（transcript-state.ts）

- **partial 按 `(source, deviceId)` 隔离**：`updateTranscriptSegments` 从后往前定位"同来源最后一段"，未 final 则更新，否则追加；禁止回退为"最后一个未 final 段"的全局逻辑（多路会互相覆盖）
- 计时器以 `timerRef.current === null` 守卫防重复（多路 onStatusChange 都会触发）
- 声纹聚类特征按路隔离（`Map<deviceId, VoiceprintFeature[]>`），禁止跨路混聚（mic 与 speaker 音色分布不同）

## 4. 采集与客户端模型

- 每路 = 一个 `FunASRClient` 实例（`asrClientsRef: Map<deviceId, FunASRClient>`）；网关天然多会话，`captureSessionId` 区分
- 错误策略（v1）：任一路失败 → 停止全部 + checkpoint 暂停；单路恢复重建留待后续
- 录音期间 `DeviceSelector` 禁用勾选，勾选集合仅在下次开始录音时生效
