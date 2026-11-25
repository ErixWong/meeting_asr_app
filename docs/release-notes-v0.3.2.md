# v0.3.2 发布说明

`v0.3.1` 之后的补丁版，只有一件事：**PATCH 的保存重试现在也是幂等的**。

**无数据库迁移**（`SCHEMA_VERSION` 仍是 6，v0.3.1 已建好的 `idempotency_keys` 直接复用）。

---

## 一、升级须知

**没有 schema 变更、没有配置变更、没有行为变更需要人工处理。** 拉代码 + 重启即可。

---

## 二、`PATCH /api/meetings/:id` 的保存重试幂等

### v0.3.1 为什么没做

PATCH 的副作用分散在四个独立事务里：

```
appendMeetingTranscript（自己的事务，提交）
  → updateMeeting（另一个事务）
  → updateTranscriptMeetingStatus（另一个事务）
  → void createMeetingLlmResult(...)（fire-and-forget）
```

一个幂等键无法原子覆盖这四步。半吊子实现只能在两种坏结果里二选一：
**重试跳过遗漏的副作用**，或 **重复追加**。

### 本版做了什么

1. **把保存路径收进单事务**：抽出 `appendMeetingTranscriptInTx` / `updateMeetingInTx` /
   `updateTranscriptMeetingStatusInTx`（只抽取，对外行为不变），新增
   `finalizeMeetingSave()` —— 追加 + 标题 + 状态 + 完成幂等键，**全在一个事务里**
2. **完成幂等键也在事务内**：`completeIdempotencyKey(..., tx)` 返回 false 就抛错让事务回滚，
   不会出现「会议改了但键没完成」
3. **LLM 触发改成可重放**：新增 `ensureMeetingLlmResult()` —— 已有可用结果就跳过；
   放在事务之后且**重放时也跑**，这样「首次已提交但响应丢了」的重试能补上生成，又不会重复生成
4. **幂等键绑定会议**：同一个 key 被用到别的会议上会返回 409，不会把 A 的保存结果返回给 B

### 顺带修掉一个既有缺陷

参数校验（status 白名单 / transcribed 必须带 finalize / finalize 必须带 status）**前移到写库之前**。
以前无效 `status` 会**先把转写追加进去再返回 400**。

同时恢复「对可解析的请求，不存在的会议返回 404」优先于字段校验。

---

## 三、验证

| 项 | 结果 |
|---|---|
| `test:meeting-save`（新增） | **12 个用例** |
| 全部测试套件 | **15 个 / 158 个用例**全绿 |
| `tsc --noEmit` | 0 |
| CI（app-gates + 三库） | 双绿 |

**变异验证**（都实测过会变红）：

| 把修复改坏 | 变红的用例 |
|---|---|
| 把 `completeIdempotencyKey` 挪出事务 | 用例 4（令牌被换 → 必须抛错并回滚，转写不落库） |
| 删掉「幂等键绑定会议」的校验 | 用例 10（跨会议必须 409，且两边都不变） |
| 去掉 `resultType !== "translation"` | 用例 11（只做过翻译的会议仍须生成纪要） |
| 删掉 `ensureMeetingLlmResult` 的存在性检查 | 用例 5（不重复生成） |

> 注：用例 1/2 验证的是「重放不重复写入」，不验证事务回滚语义 —— 把完成动作挪出事务时它们也会失败，
> 但那是 SQLite 单连接下「事务未提交时另开连接」的副作用，不能算作语义层面的证据。

---

## 四、升级步骤

```bash
git fetch --tags && git checkout v0.3.2
docker compose up -d
docker logs -f meeting_asr_app-app-1
```

**已升级到 v6 的数据库**不应再出现 `[DB] Migration applied`（没有新迁移）。
仍是 v5 的库首次启动会照常应用 v6。

---

## 已知未解决

| 项 | 说明 |
|---|---|
| #46 | TTS 网关 4 个端点入向无鉴权（内网 + 自托管上游，低优先；升格判据在 issue 里） |
| — | `main` 未开分支保护，CI 门禁不拦合并 |
