# 英文会议支持指南

会议系统从"中文会议"切换到"英文/中英混合会议"的操作手册。涉及三个独立层面，互不阻塞（可只启用需要的层）：

```
┌─────────────────────────────────────────────────────────┐
│ 英文会议全链路                                           │
│                                                         │
│  ① ASR 转写层：SenseVoiceSmall 多语种（中英日韩）       │
│  ② 声纹识别层：中英双语版 CAM++ 容器（funasr-voiceprint-en）│
│  ③ 纪要生成层：英文 prompt 模板 + 设为默认              │
└─────────────────────────────────────────────────────────┘
```

实测基准（2026-08-13）：
- 双语版声纹：中文示例同人相似度 0.67（中文版 0.69~0.82），内存 ~370MB，单句 ~125ms
- 声纹名显示：注册名支持英文（`^\w\- 中文{1,64}$`，如 Alice / Bob）
- 识别阈值：默认 0.35；英文真实人声建议注册后按实际相似度微调（同人一般 ≥0.5，异人 ~0.0）

## 1. 前提条件

| 项 | 说明 |
|---|---|
| 声纹双语容器 | `funasr-voiceprint-en` 运行中（`docker ps` 确认；部署见 [funasr-voiceprint-deployment.md](funasr-voiceprint-deployment.md)） |
| ASR 多语模型 | SenseVoiceSmall 已就位（模型目录 `SenseVoiceSmall-onnx`；部署见 [funasr-models.md](funasr-models.md) §4.2 方案 A） |
| admin 权限 | 需要 `system_admin` 角色（ASR 切换、声纹模型选择、模板管理均在 admin 后台） |

## 2. 操作步骤

### 步骤 A：ASR 转写切到多语种（SenseVoiceSmall）

1. 按 [funasr-models.md](funasr-models.md) §4.2 方案 A 部署/切换 SenseVoiceSmall 服务
2. SenseVoice 通过 `<|lang|>` 标记自动识别语种（中英日韩粤），**无需逐会话指定**
3. 验证：录一段英文说一句"Let's start the meeting"，转写应为英文文本（无中文化乱码）

> 注意：默认部署的中文 Paraformer 识别英文属非标准行为，效果不保证——英文会议必须切 SenseVoice。

### 步骤 B：声纹识别切到双语版

1. 登录 admin 后台 →「声纹管理」tab
2. 「识别模型」下拉选 **中英双语版 CAM++（英文会议）** → 保存配置
3. 顶部确认双语版卡片为绿色「正常」（若不可达，检查 `funasr-voiceprint-en` 容器）
4. **在该库注册英文说话人**：姓名填英文（如 Alice、Bob），用麦克风录 ≥2 秒或上传音频；建议每人 2~3 段
5. 验证：会议页录音，说话人显示为注册的英文名

> 重要：两模型声纹库独立（`data/voiceprints.db` / `data-en/voiceprints.db`），切换模型后需在对应库重新注册；中文库已有数据不受影响。

### 步骤 C：纪要生成用英文模板

1. admin 后台 →「模板管理」tab → 新建模板
2. 模板类型选纪要（prompt），内容用英文书写，例如：

```
You are a meeting minutes assistant. Summarize the following
meeting transcript in English, organized by topic with action
items and owners. Use the speaker names as provided.
```

3. 保存后在设置中把「默认纪要模板」切换为刚建的模板（或开会时按需指定）
4. 验证：会议结束生成纪要，输出为英文且结构完整

## 3. 回切中文会议

| 层 | 操作 |
|---|---|
| ASR | 切回中文 Paraformer（[funasr-models.md](funasr-models.md) §4.1） |
| 声纹 | 「识别模型」下拉切回**中文版 CAM++**（中文库说话人仍在） |
| 纪要 | 「默认纪要模板」切回中文模板 |

## 4. 边界与注意事项

- **中英混合会议**：ASR（SenseVoice 自动语种）与声纹（双语版）直接支持；纪要模板建议用双语 prompt（"输出中文纪要，英文发言保留原文"）
- **英文说话人区分度**：双语版在中文示例上略低于中文版（0.67 vs 0.69+），英文真实人声应注册后实测；若误识偏多调高阈值（0.4~0.5），漏识偏多调低
- **短句识别**：<0.2s 的句子不会触发服务端识别（前端门槛与服务端 MIN 对齐），短应答（ok / yes）保持聚类兜底
- **降级**：任一服务不可达时，对应层自动降级（声纹→前端聚类、ASR→不可用），录音主流程不受影响

## 5. 相关文档

- 声纹部署：[funasr-voiceprint-deployment.md](funasr-voiceprint-deployment.md)（双容器、模型选择、备份、FAQ）
- ASR 模型选型：[funasr-models.md](funasr-models.md)（SenseVoice 方案 A 部署命令）
- 声纹设计：[design/funasr-voiceprint.md](design/funasr-voiceprint.md)
- 纪要生成管线：[design/llm-generation-pipeline.md](design/llm-generation-pipeline.md)
