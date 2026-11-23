# v0.3.0 发布说明

截至 `main`（`9cd6aee`），`v0.2.0..9cd6aee` 共 **158 个提交**（含 36 个 merge commit，不含本次发布提交）。
其中非 merge 提交 **122 个**：`fix` 50 / `feat` 34 / `docs` 18 / `test` 9 / `chore` 9 / 其他 2（1 个 Revert、1 个 ci）。

本次发布按主题归类。**升级前请读「升级须知」**。

---

## 一、升级须知（会改变现有行为）

### 1. 初始管理员首次登录必须改密

空库首启播种的 `system_admin`，`must_change_password` 现在**默认为 1**（此前为 0）。
用内置默认口令或 env 提供的初始口令登录后，会被强制跳转改密页，改完前所有业务接口返回
`403 Password change required`。

- 显式豁免：设 `BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE=true`。
  ⚠ `docker-compose.yml` **没有**透传这个变量，Compose 部署需要在 `environment:` 里自己加一行。
- **已有 active `system_admin` 的实例不受影响**：播种只在空库 / 无 active `system_admin` 时跑。
  要收紧现有账号，用后台「重置密码」，
  或 `UPDATE users SET must_change_password = 1 WHERE account_name = '<账号>';`

### 2. 容器启动会检测依赖变更

`docker-compose.yml` 的启动条件现在会在 **`package-lock.json` 比已装依赖新**时重跑 `npm ci`，
并在构建条件里纳入 `package-lock.json`。

此前只判断「`node_modules` 是否存在」，而它是 bind mount、文件一直存在，
所以改 lock 之后 `npm ci` 永不触发 —— 依赖升级会静默失效（issue #82）。

代价：改依赖后的第一次重启会多花一次 `npm ci` + `next build` 的时间；无变更时仍会跳过。

### 3. 录音保存失败不再自动重试

`createMeeting` 不去重、`asr_capture_sessions` 也没有 `meeting_id` 幂等键，
自动重发会造出重复会议/重复转写段。现在失败后保留已转写内容 + 一个显式「重试保存」按钮。

---

## 二、安全

| 修复 | 说明 |
|---|---|
| AI 标题跨用户越权（IDOR） | 生成标题时未校验会议归属，任意登录用户可对他人会议触发 |
| 登录开放重定向 | `next` 参数未做同源校验 |
| 禁用账号未撤销会话 | 禁用后既有 session 仍可用 |
| 审计日志留存正文 | 审计快照把会议正文一并入库 |
| Markdown 危险协议 | `javascript:` 等协议未过滤，已抽 `safeHref` 白名单 |
| 队列身份隔离 | 排队任务在**入队时**捕获调用者身份、**执行时**恢复；无身份的入队走 `actorContext.exit` 失败关闭，不再继承启动 pump 的那个请求的身份 |

## 三、数据完整性

**停止录音不再丢转写**（issue #70）。修复的是一组路径，不是一个 bug：

- 取消命名 → 改用默认名保存，不再丢弃
- 停止时把**所有**分段补标 final（此前尾段会被丢掉）
- 保存失败保留内存转写 + 显式重试入口
- 录音中切换会议被拦截
- `beforeunload` 拦截刷新/关闭
- 保存互斥改为「入口置锁 + 覆盖全过程的 `finally` 复位」。
  原先的 60 秒自愈锁不成立的原因链：请求超过 60 秒时 TTL 到期、放行第二个请求，
  随后**旧请求**的 `finally` 会把新请求刚置的锁清成 0。

## 四、录音与音频

- 服务端旁路录制原始 PCM，会议结束时转 MP3 并绑定到会议
- 会议录音在线播放与下载（HTTP Range 流式）
- `meeting_audio_recordings` 表 + schema 迁移 v3
- 孤儿录音 72h 清理
- 录音保留设置项 + 详情页「已到期清理」投影 + 顶部常驻磁盘水位告警

## 五、数据库

- **#54**：运行时全面接入 `getKnex()` + `AsyncDb`，114 处同步调用改异步，legacy 手写 DDL 退役；
  `AsyncDb` 事务串行化 + 事务句柄显式传递（事务内误用 `db` 直接抛错）
- **#55**：三库（sqlite / mysql / mssql）方言敏感语法清零 —— 跨库 upsert / insertIgnore 工具、
  方言分页与补列、`affected-rows` 兜底，并新增三库事务套件 `db:test-tx`

> ⚠ 真实支持面：`sqlite` 为生产默认并已验证；`mysql` / `mssql` 的建表、迁移、版本记账、
> 生产入口初始化已三库跑绿，业务路径的方言清零见 #55。

## 六、AI 能力

- **#44**：AI 标题生成（历史列表/详情入口 + toast 一次性撤销）
- 翻译持久化与历史会议再次翻译（版本化、零 schema 迁移、多语言并存）
- 纪要/清洗生成从流式 SSE 改为非流式 JSON，解析更可靠
- 剥离生成结果里的思考标记（`<think>...</think>` 等）
- 启动对账：进程启动时重置卡在 `llm_processing` 的会议（服务重启导致内存队列任务丢失的场景）
- LLM 调用默认超时 180s → 300s

## 七、TTS 与语音对话

- TTS 支持 OpenAI 兼容标准协议（provider 可切换，可接任意兼容服务）
- 默认音色改为下拉框（cosyvoice 实时拉取 `/voices` + OpenAI 官方 6 音色 + 自定义兜底）
- 语音对话 M3：`/api/chat` 多轮编排 + 前端对话页
- 语音对话 M4：多语言自动选音色 / 英文断句 / 后台 TTS 配置页 / 错误降级

## 八、工程与运维

- **CI 门禁**（`.github/workflows/app-gates.yml`）：`tsc --noEmit` + `next lint` + 10 个测试套件 + 生产构建；
  另有**漂移守卫**——`package.json` 里每个 `test:*` 必须被 workflow 跑到，漏了当场红
- **依赖漏洞清零**：`next 15.5.29` / `nodemailer 10.6.1` / `sharp 0.35.5`，`npm audit` 从 16 条降到 **0 条**
  ⚠ `nodemailer` 是 **9.x → 10.x 的 major 升级**。本项目只用到 `createTransport` / `sendMail` 基础路径，
  但请在升级后实测一次真实 SMTP 发送（含 SSL 开关两种模式）再依赖它做告警邮件。
- **10 个测试套件、110 个用例**：title 18 / chat 9 / audio 26 / retention 14 / tts 15 /
  asr-origin 13 / queue-ctx 4 / queue-actor 2 / safe-href 5 / bootstrap-admin 4
- `LlmQueue.whenQuiescent()`：新增**可调用**的「等队列静默」方法（等待者模式，不轮询）。
  注意：`server/app-server.mjs` 的关闭流程**尚未**调用它，生产进程也不调 `closeDb()`；
  当前它只被测试使用，接入优雅关闭是后续独立改动。

---

## 已知未解决（不阻塞发布）

| 项 | 说明 |
|---|---|
| #74 | 录音保护残留：导航拦截需 layout 级方案 / `connecting` 期间取消 / 保存幂等键 / 跨刷新草稿 |
| #46 | TTS 网关入向无鉴权（内网自托管上游，低优先；升格判据已写在 issue 里） |
| #56 | SQLite 自动备份在 `89b4068` 被**整体回滚**，当前生产库**没有**任何自动备份；issue 已重新打开 |
| — | `main` 分支未开保护，CI 门禁目前**不拦合并**（仅提示） |

## 升级步骤

```bash
git fetch --tags && git checkout v0.3.0
docker compose up -d          # 启动脚本会自动检测依赖/源码变更并重装、重建
docker logs -f meeting_asr_app-app-1
```

首次登录会被要求改密（见「升级须知 1」）。
