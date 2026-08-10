# LLM 思考模式输出结构测试报告

> 主题：Qwen3 推理模型思考内容混入翻译输出问题的定位、修复与验证
> 日期：2026-08-10

## 1. 背景

实时翻译应用调用 Qwen3 系推理模型（`qwen3.6-35b`）时，模型思考模式默认开启。实际使用中发现返回的 `content` 里混入了大量思考内容（思考流、自我修正叙述、`<think>`/`</think>` 标签等），导致翻译结果被污染。本次测试定位根因、验证修复，并建立可复现的回归脚本。

## 2. 测试端点

| 组别 | URL | API Key | Model | 部署形态 |
|------|-----|---------|-------|----------|
| 第一组 | `http://cnzhe-app201.intevaproducts.com:8090` | `erix-llama-key` | `erix395/qwen3.6-35b` | llama.cpp（llama-server，Vulkan0） |
| 第二组（参考标准） | `http://10.41.24.146:4000` | `sk-PG-Gd5mKft6XYYK9-ph3zw` | `qwen3.6:35b` | 参考网关（reasoning_budget=2048） |

第一组关键启动参数（随时间演变，见第 5 节）：

```
--reasoning-budget 1024
--jinja
--chat-template-kwargs '{"enable_thinking":true}'
--batch-size 1024 --ubatch-size 256   # 后加，仅影响吞吐，与思考切分无关
```

## 3. 测试脚本

| 脚本 | 用途 | 用法 |
|------|------|------|
| `verify-llm-translate-output.mjs` | 验证关闭思考参数下输出纯净度（日常回归） | `node tests/verify-llm-translate-output.mjs`（默认）<br>`node tests/verify-llm-translate-output.mjs --baseline`（参数组合对照） |
| `verify-llm-thinking-structure.mjs` | 诊断思考模式下响应结构（reasoning_content/content 分配、污染检测、strip 兜底模拟） | `node tests/verify-llm-thinking-structure.mjs` |

环境变量覆盖：`LLM_URL` / `LLM_API_KEY` / `LLM_MODEL`（不设置则用第一组默认值）。

两个脚本对任意端点发送**相同提示词**（实时会议翻译，3 句英文原文 → 中文，要求逐行对应），提示词与 `src/lib/admin-store.ts` 中 `translateSentences` 一致（不含任何"禁止思考"类指令，该类指令实测无效，见第 6 节）。

## 4. 标准行为（第二组参考端点）

思考模式下响应结构（message 键：`role` / `content` / `reasoning_content` / `provider_specific_fields`）：

| 测试次数 | reasoning_content | content | completion_tokens | content 纯净度 |
|----------|-------------------|---------|-------------------|----------------|
| 1 | 5287 字（完整收尾 `*(Done.)*`） | 166 字（纯译文） | 1843 | 纯净 |
| 2 | 6206 字（完整） | 166 字（纯译文） | 2145 | 纯净 |
| 3 | 6410 字（完整） | 163 字（纯译文） | 2145 | 纯净 |

**标准行为定义**：
- 思考内容完整进入 `reasoning_content`（正常收尾，不截断）
- `content` 只含最终译文，零污染
- 应用只需读 `message.content`，无需任何后处理

## 5. 第一组测试演化（定位根因过程）

| 阶段 | 服务端形态 | reasoning_content | content | 问题 |
|------|-----------|-------------------|---------|------|
| ① 初始 | 定制版 rocmfp4-server | 3391 字（截断副本） | 4472 字：完整思考流 + `</think>` + 译文 | 思考全量泄漏进 content |
| ①' max_tokens=1024 | 同上 | 3169 字 | **空**（思考占满 budget，`finish_reason=length`） | 译文丢失 |
| ② 用户调整后 | 同上 | 3421 字（截断） | 1002 字：译文 + 思考尾巴 + `</think>` + 译文 | 尾巴泄漏 |
| ③ 仅 `--jinja` | 定制版 + jinja | **无此字段** | 1784 字：思考流 + `</think>` + 译文 | 思考全量进 content |
| ④ 加 `--chat-template-kwargs enable_thinking:true` | 定制版 + jinja + 思考开 | 3351 字（截断） | 3622 字：译文草稿 + 尾巴 + `</think>` + 译文 | reasoning 恢复但切分错位 |
| ⑤ 复测 | 同上 | 3339 字（截断） | 3938 字（切分点切进译文草稿中间） | 同 ④ |
| ⑥ 更换模型 GGUF | 同上 | 3004 字（截断） | 4084 字（同构问题） | **换模型不解决**，根因在 server 实现 |
| ⑦ **更换标准 llama.cpp** | 标准版 | 3204 字（截断） | **165 字（纯译文）** | 首次干净 |
| ⑧ 加 batch/ubatch 参数 | 标准版 | 3277 / 3483 字 | 2323 / 912 字 | **波动：截断点随机** |

### 关键发现

1. **定制版 rocmfp4-server 缺陷**：reasoning 切分/归因错误——`reasoning_content` 截断、思考区间外内容（后思考尾巴 + 文本 `</think>`）漏进 `content`。更换标准 llama.cpp 后基本解决。
2. **`--reasoning-budget 1024` 是截断根源**：思考达到 1024 tokens 被强制掐断（实测 reasoning_content ~3000-3500 字 ≈ 1024 tokens 线），截断点可能切进译文草稿中间。
3. **截断点位置随机 → content 干净与否是概率事件**（同一配置下 165 / 2323 / 912 字三种结果）：
   - 截断在思考尾声（检查约束阶段）→ 模型直接输出译文 → content 干净
   - 截断在思考中途（译文草稿阶段）→ 模型惯性输出尾巴 chatter → content 脏
4. **`--batch-size` / `--ubatch-size` 与思考切分无关**（仅影响吞吐）。
5. **模型换 GGUF 文件不解决问题**（⑥），根因在 server 实现（⑦ 验证）。

## 6. 无效方案：提示词禁令

"禁止输出思考过程或 think 标签"类提示词**无效**：
- 思考流是模板层强制行为（Qwen3 思考模式下思考 token 就是生成序列的一部分），提示词约束的是内容，管不住机制
- 实测泄漏输出中，禁令指令被思考流当作**引用对象反复复述**（"只输出译文，每行对应原文一行…"被完整引用）
- 已在代码中移除所有此类指令，提示词只保留纯格式约束

## 7. 应用侧解决方案（已落地）

| 层 | 机制 | 位置 |
|----|------|------|
| 配置开关 | `llm:thinking_model`（"模型是否带思考模式"），默认开启；关闭时不再附加任何思考参数 | `src/lib/admin-store.ts` |
| 请求参数 | 开启时三参数同发：`enable_thinking:false` + `chat_template_kwargs:{enable_thinking:false}`（llama.cpp/vLLM 实际生效）+ `think:false`（Ollama） | `buildDisableThinkingParams()` |
| 后处理兜底 | `stripLeadingThinking`：取最后一个 `</think>` 之后内容；剥 `<think>`/`<thinking>`/`<reasoning>` 块 | `src/lib/admin-store.ts` |

覆盖调用点：实时翻译 `translateSentences`、选中翻译 `translateSelection`、纪要生成 `createMeetingLlmResultInner`、后台测试 `test-llm`。

非思考模式（应用默认路径）在两组端点上均稳定纯净；思考模式下的污染由 `</think>` 截断兜底，历次测试全部成功（155~174 字纯净译文）。

## 8. 复现与回归

```bash
# 第一组（默认）
node tests/verify-llm-translate-output.mjs
node tests/verify-llm-thinking-structure.mjs

# 第二组（参考标准）
$env:LLM_URL="http://10.41.24.146:4000"; $env:LLM_API_KEY="sk-PG-Gd5mKft6XYYK9-ph3zw"; $env:LLM_MODEL="qwen3.6:35b"
node tests/verify-llm-translate-output.mjs
node tests/verify-llm-thinking-structure.mjs
```

回归检查点：
- [ ] 非思考模式：content 纯净、无 think 标记、行数与原文一致
- [ ] 思考模式：`reasoning_content` 存在性、content 污染检测、strip 兜底结果
- [ ] 服务端重启后重测（代码/参数修改必须重启服务）

## 9. 遗留建议

- 若希望思考模式下 content 也稳定干净：去掉/调大 `--reasoning-budget` 让思考自然收尾（对齐第二组行为），代价是响应变慢（思考 ~1700+ tokens）
- 思考模式的尾巴污染本质是"模型思考被截断后的惯性输出"，服务端配置层已到极限，剩余靠应用层兜底
