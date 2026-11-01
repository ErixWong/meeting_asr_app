/**
 * 会议 AI 标题（feat-261101-04 / GitHub #44）单测（node --test）
 *
 * 覆盖：
 *   T1 src/lib/ai-title.ts  清洗纯函数   —— 引号（中/英）/ 换行 / 首尾标点 / 连续空白 /
 *                                           「标题：」前缀 / 30 字符边界（按码点）/ 空兜底
 *   T2 src/lib/ai-title.ts  正文窗口     —— 1 小时会议几万字必须截断后再送模型
 *                                          （开头 + 结尾窗口，中间省略；不整段塞 raw_payload）
 *   T3 tpl-title 种子       老库场景     —— `llm_prompt_templates` 非空（种子块不跑）时
 *                                          仍必须有无条件插入；已存在则不覆盖用户改动
 *   T4 真实链路（真实 sqlite + 真实队列 + 真实记账，只有 LLM 传输层是桩）：
 *        入队任务类型 "title" / 状态机 / 改名 / meeting_llm_results 记账 / 审计 /
 *        投影一致（列表与详情同源）/ 模型名与 key 只来自库里的设置
 *   T5 失败路径：上游 500 → 不改标题、落 status=failed 记账行、审计 result=failed
 *   T6 清洗兜底：模型只回了引号 → 标题退回原名，绝不改成空串
 *   T7 并发点击：两个并发都成功，后者覆盖前者，不留半更新状态
 *   T8 越权：别人的会议 → 404（AiTitleError），不动任何数据
 *
 * 运行：npm run test:title（= node --test scripts/ai-title-test.mjs，需 Node 24：node:sqlite）
 * 说明：
 *   * 临时库落在 os.tmpdir() 沙箱里（测试开始 chdir 进去），收尾整目录删除，不污染仓库；
 *   * **测试里不出现任何真实模型名 / API key**：模型名从库里的 `llm.model` 设置读出来再断言，
 *     api_key 保持种子的空值，并断言请求头里没有 Authorization；
 *   * admin-store.ts 是 TS 且用 `@/` 别名，这里用 `module.registerHooks` 做别名解析，
 *     由 Node 24 原生类型擦除直接跑**真实源码**（不复制一份到测试里）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;
const sandbox = mkdtempSync(join(tmpdir(), "ai-title-test-"));
process.chdir(sandbox);

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 加载真实源码：`@/` → src/（admin-store.ts 依赖 store-utils / llm-queue / ai-title）
// ---------------------------------------------------------------------------

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = join(repoRoot, "src", specifier.slice(2));
      for (const candidate of [`${base}.ts`, `${base}.tsx`, base, join(base, "index.ts")]) {
        if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
      }
    }
    return next(specifier, context);
  },
});

const { DatabaseSync } = await import("node:sqlite");
const { initializeDatabase } = await import(join(repoRoot, "server", "database-schema.mjs"));

// 「老库」现场：库文件已存在且 `llm_prompt_templates` 里已经有一条（非内置的）模板。
// 这样 admin-store 的 seedDefaults 里 `if (templateCount === 0) { …tpl-1/tpl-2… }` 整块不会跑，
// 只有**无条件**的 tpl-title 插入才能让模板存在 —— 正是工单要防的回归点。
const dataDir = join(sandbox, "data");
const dbPath = join(dataDir, "meeting-asr-app.db");
mkdirSync(dataDir, { recursive: true });
{
  const bootstrap = new DatabaseSync(dbPath);
  initializeDatabase(bootstrap);
  bootstrap
    .prepare(`
      INSERT INTO llm_prompt_templates (
        id, template_key, template_name, template_type, content, description, status, is_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "tpl-legacy",
      "legacy_custom",
      "老库里的自定义模板",
      "minutes",
      "老库模板正文 {transcript}",
      "模拟老库：种子块不会跑",
      "active",
      0,
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z"
    );
  bootstrap.close();
}

const store = await import(pathToFileURL(join(repoRoot, "src", "lib", "admin-store.ts")).href);
const aiTitle = await import(pathToFileURL(join(repoRoot, "src", "lib", "ai-title.ts")).href);
const { llmQueue } = await import(pathToFileURL(join(repoRoot, "src", "lib", "llm-queue.ts")).href);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const db = () => new DatabaseSync(dbPath);

function withDb(fn) {
  const handle = db();
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

function rows(sql, ...params) {
  return withDb((handle) => handle.prepare(sql).all(...params));
}

function one(sql, ...params) {
  return rows(sql, ...params)[0];
}

/** 造一段「1 小时会议」级别的正文：约 4 万字，中段/结尾各埋一个哨兵。 */
const TRANSCRIPT_MARK_HEAD = "【开头哨兵：本季度产品路线评审】";
const TRANSCRIPT_MARK_MIDDLE = "【中段哨兵：这段应当被窗口截掉】";
const TRANSCRIPT_MARK_TAIL = "【结尾哨兵：结论是先把稳定性做扎实】";

function buildLongTranscriptSegments() {
  const segments = [];
  let index = 0;
  const push = (text) => {
    segments.push({
      id: `seg-${index}`,
      speaker: index % 2 === 0 ? "说话人A" : "说话人B",
      speakerId: (index % 2) + 1,
      text,
      time: "00:00",
      timeSeconds: index,
      isFinal: true,
    });
    index += 1;
  };

  push(TRANSCRIPT_MARK_HEAD);
  for (let i = 0; i < 120; i += 1) push(`第${i}段：我们讨论了接口联调、灰度节奏与回滚预案，确认下周三前给出结论。`);
  push(TRANSCRIPT_MARK_MIDDLE);
  for (let i = 0; i < 120; i += 1) push(`第${i + 120}段：继续对齐埋点口径、告警阈值与值班安排，细节由各组自行跟进。`);
  push(TRANSCRIPT_MARK_TAIL);
  return segments;
}

const ADMIN = store.getActorByAccountName("admin");
assert.ok(ADMIN, "种子里的 admin 账号应存在");

let meetingSeq = 0;

function createMeetingWithSegments(segments, title = "未命名的原始标题") {
  meetingSeq += 1;
  return store.runWithActor(ADMIN, () =>
    store.createMeeting({
      title: `${title}-${meetingSeq}`,
      sourceType: "file_upload",
      sourceFileName: "fixture.wav",
      durationSeconds: 3600,
      captureSessionId: "",
      transcriptSegments: segments,
    })
  );
}

/** 真实 LLM 传输层替换成桩：返回 OpenAI 兼容 body，并把请求记下来。 */
const transportCalls = [];

function installTransport(handler) {
  transportCalls.length = 0;
  store.setLlmTransport(async (url, options) => {
    const call = { url, options, body: JSON.parse(options.body) };
    transportCalls.push(call);
    const reply = await handler(call, transportCalls.length);
    return { status: reply.status ?? 200, text: reply.text ?? "", headersAt: Date.now(), bodyAt: Date.now() };
  });
  return transportCalls;
}

function chatCompletionBody(content) {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
}

/** 记录 llmQueue.enqueue 收到的任务类型（断言 "title" 走的是既有队列）。 */
const enqueuedTypes = [];
const originalEnqueue = llmQueue.enqueue.bind(llmQueue);
llmQueue.enqueue = (type, task, waitMs) => {
  enqueuedTypes.push(type);
  return originalEnqueue(type, task, waitMs);
};

// ---------------------------------------------------------------------------
// T1 清洗纯函数
// ---------------------------------------------------------------------------

test("T1 清洗：中英文引号、书名号、反引号、Markdown 粗体都要剥掉", () => {
  const cases = [
    ['"季度复盘会"', "季度复盘会"],
    ["'季度复盘会'", "季度复盘会"],
    ["“季度复盘会”", "季度复盘会"],
    ["‘季度复盘会’", "季度复盘会"],
    ["「季度复盘会」", "季度复盘会"],
    ["『季度复盘会』", "季度复盘会"],
    ["《季度复盘会》", "季度复盘会"],
    ["`季度复盘会`", "季度复盘会"],
    ["**季度复盘会**", "季度复盘会"],
    ['  “ 季度复盘会 ”  ', "季度复盘会"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(aiTitle.sanitizeMeetingTitle(input, "兜底"), expected, `输入 ${JSON.stringify(input)}`);
  }
  console.log("[T1] 引号/书名号/Markdown 剥离 OK");
});

test("T1 清洗：换行与连续空白压缩成单个空格", () => {
  assert.equal(aiTitle.sanitizeMeetingTitle("第一行\n\n第二行\t\t第三行", "兜底"), "第一行 第二行 第三行");
  assert.equal(aiTitle.sanitizeMeetingTitle("  多   个    空格  ", "兜底"), "多 个 空格");
  assert.equal(aiTitle.sanitizeMeetingTitle("带\r\n回车换行", "兜底"), "带 回车换行");
  console.log("[T1] 换行/空白压缩 OK");
});

test("T1 清洗：首尾标点与空白剥掉，中间标点保留", () => {
  assert.equal(aiTitle.sanitizeMeetingTitle("，项目周会。", "兜底"), "项目周会");
  assert.equal(aiTitle.sanitizeMeetingTitle("【重要】架构评审！！", "兜底"), "重要】架构评审");
  assert.equal(aiTitle.sanitizeMeetingTitle("…… 预算对齐 ：", "兜底"), "预算对齐");
  assert.equal(aiTitle.sanitizeMeetingTitle("Q3 目标：复盘", "兜底"), "Q3 目标：复盘", "中间的冒号必须保留");
  assert.equal(aiTitle.sanitizeMeetingTitle("- 周会纪要 -", "兜底"), "周会纪要");
  console.log("[T1] 首尾标点/空白 OK");
});

test("T1 清洗：去掉「标题：」这类前缀", () => {
  assert.equal(aiTitle.sanitizeMeetingTitle("标题：周会", "兜底"), "周会");
  assert.equal(aiTitle.sanitizeMeetingTitle("标题: 周会", "兜底"), "周会");
  assert.equal(aiTitle.sanitizeMeetingTitle("会议主题：周会", "兜底"), "周会");
  assert.equal(aiTitle.sanitizeMeetingTitle("主题公园改造评审", "兜底"), "主题公园改造评审", "没有冒号就不能当前缀剥");
  console.log("[T1] 前缀剥离 OK");
});

test("T1 清洗：长度上限 30 字符（按码点，不是字节；emoji 不许切出半个代理对）", () => {
  const long = "会".repeat(31);
  const trimmed = aiTitle.sanitizeMeetingTitle(long, "兜底");
  assert.equal(aiTitle.titleCharCount(trimmed), 30, `31 个字应截到 30，实际 ${aiTitle.titleCharCount(trimmed)}`);
  assert.equal(trimmed, "会".repeat(30));

  // 30 个字符不截（边界值）
  const exact = "会".repeat(30);
  assert.equal(aiTitle.sanitizeMeetingTitle(exact, "兜底"), exact);

  // 中英混排 + 空白：30 字以内不动
  const mixed = "Q3 产品路线评审会与稳定性复盘";
  assert.equal(aiTitle.sanitizeMeetingTitle(mixed, "兜底"), mixed);

  // emoji：按码点算 31 个 → 截到 30，且不能出现孤立代理项
  const emojis = "🎯".repeat(31);
  const cutEmojis = aiTitle.sanitizeMeetingTitle(emojis, "兜底");
  assert.equal(Array.from(cutEmojis).length, 30);
  assert.equal(cutEmojis, "🎯".repeat(30));
  assert.doesNotMatch(cutEmojis, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);

  // 截断后尾部残留的标点/空白要再清一次
  const withTailPunct = `${"会".repeat(29)}。，`;
  assert.equal(aiTitle.sanitizeMeetingTitle(withTailPunct, "兜底"), "会".repeat(29));

  assert.equal(aiTitle.TITLE_MAX_CHARS, 30, "长度上限常量必须是 30（变异验证的锚点）");
  console.log("[T1] 30 字符边界 / 码点 / emoji 安全 OK");
});

test("T1 清洗：空与异常输入必须兜底，绝不返回空串", () => {
  const fallback = "原始会议名";
  for (const empty of ["", "   ", "\n\n", "。。。。。", "“”", "''", "「」", "---", "标题："]) {
    assert.equal(aiTitle.sanitizeMeetingTitle(empty, fallback), fallback, `输入 ${JSON.stringify(empty)}`);
  }
  assert.equal(aiTitle.sanitizeMeetingTitle(null, fallback), fallback);
  assert.equal(aiTitle.sanitizeMeetingTitle(undefined, fallback), fallback);
  assert.equal(aiTitle.sanitizeMeetingTitle(12345, fallback), "12345", "非字符串走 String() 兜底");

  // 连兜底都是空 → 「未命名会议」，绝不允许空串
  assert.equal(aiTitle.sanitizeMeetingTitle("", ""), aiTitle.TITLE_FALLBACK_TITLE);
  assert.equal(aiTitle.sanitizeMeetingTitle("“”", "   "), aiTitle.TITLE_FALLBACK_TITLE);
  console.log("[T1] 空兜底 OK");
});

// ---------------------------------------------------------------------------
// T2 送模型的正文窗口
// ---------------------------------------------------------------------------

test("T2 窗口：几万字正文必须截断后再送模型（开头 + 结尾，中间省略）", () => {
  const transcript = `${TRANSCRIPT_MARK_HEAD}${"讨论内容".repeat(3000)}${TRANSCRIPT_MARK_MIDDLE}${"后续内容".repeat(3000)}${TRANSCRIPT_MARK_TAIL}`;
  const window = aiTitle.selectTitleTranscript(transcript);

  assert.equal(window.truncated, true, "4 万字的正文必须被截断");
  assert.ok(window.totalChars > 20000, `构造的正文应足够长，实际 ${window.totalChars}`);
  assert.ok(window.sentChars <= aiTitle.TITLE_TRANSCRIPT_MAX_CHARS, `送出的正文必须 ≤ ${aiTitle.TITLE_TRANSCRIPT_MAX_CHARS}，实际 ${window.sentChars}`);
  assert.ok(window.omittedChars > 0);
  assert.ok(window.text.includes(TRANSCRIPT_MARK_HEAD), "开头必须保留（会议主题通常在开头）");
  assert.ok(window.text.includes(TRANSCRIPT_MARK_TAIL), "结尾必须保留（结论通常在结尾）");
  assert.ok(!window.text.includes(TRANSCRIPT_MARK_MIDDLE), "中段必须被窗口截掉");
  assert.match(window.text, /中间省略 \d+ 字/);

  // 短正文不截断
  const short = aiTitle.selectTitleTranscript("很短的会议正文");
  assert.equal(short.truncated, false);
  assert.equal(short.text, "很短的会议正文");
  console.log(`[T2] 正文窗口 OK（${window.totalChars} → ${window.sentChars} 字，省略 ${window.omittedChars}）`);
});

test("T2 prompt：正文只以窗口形式进 prompt，模板占位符被替换", () => {
  const transcript = `${TRANSCRIPT_MARK_HEAD}${"讨论内容".repeat(3000)}${TRANSCRIPT_MARK_MIDDLE}${"后续内容".repeat(3000)}${TRANSCRIPT_MARK_TAIL}`;
  const built = aiTitle.buildTitlePrompt(aiTitle.TITLE_TEMPLATE_CONTENT, transcript);

  assert.ok(built.prompt.includes(TRANSCRIPT_MARK_HEAD));
  assert.ok(!built.prompt.includes(TRANSCRIPT_MARK_MIDDLE));
  assert.ok(built.prompt.includes("{transcript}") === false, "占位符必须被替换掉");
  // prompt 长度 = 模板 + 窗口正文 + 省略标记，绝不可能是「整段正文」
  assert.ok(
    built.prompt.length < built.totalChars / 2,
    `prompt 长度 ${built.prompt.length} 不应接近原文字数 ${built.totalChars}`
  );

  // 模板里没有 {transcript} 时正文追加在末尾（不丢正文）
  const appended = aiTitle.buildTitlePrompt("只给标题，不要解释。", "短正文");
  assert.match(appended.prompt, /短正文$/);
  console.log(`[T2] prompt 组装 OK（prompt ${built.prompt.length} 字 / 原文 ${built.totalChars} 字）`);
});

// ---------------------------------------------------------------------------
// T3 tpl-title 无条件 upsert（老库场景）
// ---------------------------------------------------------------------------

test("T3 老库（templateCount>0）也必须拿到 tpl-title", () => {
  const templates = store.listPromptTemplates();
  const ids = templates.map((item) => item.id);

  assert.ok(ids.includes("tpl-legacy"), "老库里的模板还在");
  assert.ok(!ids.includes("tpl-1"), "老库不应重跑默认种子（证明我们真的在 templateCount>0 的分支上）");

  const title = templates.find((item) => item.templateKey === "system_title");
  assert.ok(title, "tpl-title 必须存在（无条件 upsert）");
  assert.equal(title.id, "tpl-title");
  assert.equal(title.templateType, "title");
  assert.equal(title.isSystem, true);
  assert.match(title.content, /\{transcript\}/, "标题模板必须带 {transcript} 占位符");
  console.log("[T3] 老库 tpl-title 无条件插入 OK");
});

test("T3 已存在同名模板时不覆盖用户改过的内容；缺失则重新插入", () => {
  withDb((handle) => {
    const now = new Date().toISOString();
    handle
      .prepare("UPDATE llm_prompt_templates SET content = ? WHERE id = ?")
      .run("用户自己改过的标题提示词 {transcript}", "tpl-title");

    assert.equal(aiTitle.ensureTitleTemplate(handle, now), "kept");
    assert.equal(
      one("SELECT content FROM llm_prompt_templates WHERE id = ?", "tpl-title").content,
      "用户自己改过的标题提示词 {transcript}",
      "已有同名模板时不许覆盖"
    );

    // 只按 template_key 命中也算「已存在」（老库里 id 可能不是 tpl-title）
    handle.prepare("DELETE FROM llm_prompt_templates WHERE id = ?").run("tpl-title");
    handle
      .prepare(`
        INSERT INTO llm_prompt_templates (
          id, template_key, template_name, template_type, content, description, status, is_system, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("tpl-other-id", "system_title", "改过 id 的同名模板", "title", "同 key 正文 {transcript}", "", "active", 1, now, now);
    assert.equal(aiTitle.ensureTitleTemplate(handle, now), "kept", "template_key 已存在时也不许插");
    assert.equal(rows("SELECT id FROM llm_prompt_templates WHERE template_key = 'system_title'").length, 1);

    // 彻底缺失 → 重新插入
    handle.prepare("DELETE FROM llm_prompt_templates WHERE template_key = ?").run("system_title");
    assert.equal(aiTitle.ensureTitleTemplate(handle, now), "inserted");
    const inserted = one("SELECT template_key, template_type, is_system, status FROM llm_prompt_templates WHERE id = ?", "tpl-title");
    assert.equal(inserted.template_key, "system_title");
    assert.equal(inserted.template_type, "title");
    assert.equal(inserted.is_system, 1);
    assert.equal(inserted.status, "active");
  });
  console.log("[T3] 不覆盖已有 / 缺失再插入 OK");
});

// ---------------------------------------------------------------------------
// T4 真实链路：入队 / 状态机 / 改名 / 记账 / 审计 / 投影一致
// ---------------------------------------------------------------------------

test("T4 真实链路：入队 title → 改名 → 记账 → 审计 → 列表与详情同源", async () => {
  const meeting = createMeetingWithSegments(buildLongTranscriptSegments(), "原始标题");
  const llmSettings = store.listSettings().filter((item) => item.itemSection === "llm");
  const configuredModel = llmSettings.find((item) => item.itemMark === "model")?.itemValue ?? "";
  const configuredBaseUrl = llmSettings.find((item) => item.itemMark === "base_url")?.itemValue ?? "";
  const configuredApiKey = llmSettings.find((item) => item.itemMark === "api_key")?.itemValue ?? "";
  assert.ok(configuredModel, "库里的 llm.model 应有值（测试不硬编码模型名）");
  assert.ok(configuredBaseUrl, "库里的 llm.base_url 应有值");
  assert.equal(configuredApiKey, "", "种子里的 api_key 为空 → 测试不涉及任何 key");

  // 模型这次回了个「脏」标题：引号 + 换行 + 尾部标点
  const calls = installTransport(() => ({ text: chatCompletionBody('“  2026 Q3 产品路线评审会  ”\n') }));
  enqueuedTypes.length = 0;

  const result = await store.runWithActor(ADMIN, () => store.generateMeetingTitle(meeting.id));

  // 1) 走的是既有 llm 队列，任务类型 "title"
  assert.deepEqual(enqueuedTypes, ["title"], "必须经 llmQueue.enqueue(\"title\") 入队");

  // 2) 请求体：模型/URL 全部来自库里的设置，没有硬编码；没有 key 就不发 Authorization
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, configuredModel, "模型名必须来自库里的 llm.model 设置");
  assert.equal(calls[0].url, `${configuredBaseUrl.replace(/\/$/, "")}/chat/completions`);
  assert.equal(calls[0].options.headers.Authorization, undefined, "api_key 为空时不许发 Authorization");
  assert.match(calls[0].url, /\/chat\/completions$/);

  // 3) 发给模型的 prompt：正文被截断/分段，绝不是整段 raw_payload
  const promptText = calls[0].body.messages.map((message) => String(message.content)).join("\n");
  assert.ok(promptText.includes(TRANSCRIPT_MARK_HEAD), "开头哨兵应出现在 prompt 里");
  assert.ok(promptText.includes(TRANSCRIPT_MARK_TAIL), "结尾哨兵应出现在 prompt 里");
  assert.ok(!promptText.includes(TRANSCRIPT_MARK_MIDDLE), "中段哨兵必须被窗口截掉（不许整段塞 prompt）");
  assert.ok(
    promptText.length < 12000,
    `prompt 长度必须受控，实际 ${promptText.length} 字（原文 ${result.transcriptChars} 字）`
  );
  assert.equal(result.truncated, true);
  assert.ok(result.sentChars <= aiTitle.TITLE_TRANSCRIPT_MAX_CHARS);

  // 4) 清洗后的标题：去引号 / 去换行 / 去尾标点
  assert.equal(result.title, "2026 Q3 产品路线评审会");
  assert.equal(result.previousTitle, meeting.title);

  // 5) 真的改名了（DB 与投影都变了）
  assert.equal(one("SELECT title FROM meetings WHERE id = ?", meeting.id).title, result.title);
  const listRow = store.runWithActor(ADMIN, () => store.listMeetings()).find((item) => item.id === meeting.id);
  assert.equal(listRow.title, result.title, "列表行必须反映新标题");
  const detail = store.runWithActor(ADMIN, () => store.getMeetingById(meeting.id));
  assert.equal(detail.title, result.title, "详情必须反映新标题");
  // 列表与详情走同一个投影函数 → 返回的 meeting 对象与 getMeetingLightById 逐字段一致
  const light = store.runWithActor(ADMIN, () => store.getMeetingLightById(meeting.id));
  assert.deepEqual(result.meeting, light, "接口返回的 meeting 必须就是共享投影函数的产物");

  // 6) 记账：meeting_llm_results 一行 succeeded，result_type = title
  const llmRow = one("SELECT * FROM meeting_llm_results WHERE id = ?", result.llmResultId);
  assert.equal(llmRow.status, "succeeded");
  assert.equal(llmRow.result_type, "title");
  assert.equal(llmRow.result_title, result.title);
  assert.equal(llmRow.result_markdown, result.title);
  assert.equal(llmRow.error_message, null);
  assert.ok(llmRow.version_no >= 1);
  assert.equal(llmRow.prompt_template_id, "tpl-title");
  const snapshot = JSON.parse(llmRow.generation_config_snapshot);
  assert.equal(snapshot.model, configuredModel);
  assert.equal(snapshot.source, "ai_title");
  assert.equal(snapshot.truncated, true);
  assert.ok(!("apiKey" in snapshot) && !("api_key" in snapshot), "记账快照里不许出现 api key");
  assert.ok(!llmRow.raw_prompt.includes(TRANSCRIPT_MARK_MIDDLE), "落库的 raw_prompt 也必须是窗口后的正文");

  // 7) 审计：llm.title，带 before/after 标题
  const audit = one("SELECT * FROM audit_logs WHERE resource_id = ? AND action_type = 'llm.title'", meeting.id);
  assert.ok(audit, "必须写 llm.title 审计");
  assert.equal(audit.result, "success");
  assert.equal(JSON.parse(audit.before_snapshot).title, meeting.title);
  assert.equal(JSON.parse(audit.after_snapshot).title, result.title);

  // 8) 标题记账行不能污染「生成结果」版本列表与列表摘要
  const summaries = store.runWithActor(ADMIN, () => store.listMeetingLlmResultSummaries(meeting.id));
  assert.ok(summaries.every((item) => item.resultType !== "title"), "标题行不许出现在纪要版本列表里");
  assert.equal(listRow.summary, "", "标题行不许被当成会议摘要");

  store.setLlmTransport(null);
  console.log("[T4] 入队/改名/记账/审计/投影一致 OK");
});

// ---------------------------------------------------------------------------
// T5 失败路径
// ---------------------------------------------------------------------------

test("T5 失败路径：上游 500 → 不改标题、落 failed 记账行、审计 failed", async () => {
  const meeting = createMeetingWithSegments(buildLongTranscriptSegments(), "失败用例原标题");
  installTransport(() => ({ status: 500, text: "upstream exploded" }));

  const rowsBefore = rows("SELECT id FROM meeting_llm_results WHERE meeting_id = ?", meeting.id).length;

  await assert.rejects(
    () => store.runWithActor(ADMIN, () => store.generateMeetingTitle(meeting.id)),
    (error) => {
      assert.equal(error.name, "AiTitleError");
      assert.equal(error.status, 502, "上游失败映射 502");
      assert.match(error.message, /LLM API error: 500/);
      return true;
    }
  );

  assert.equal(one("SELECT title FROM meetings WHERE id = ?", meeting.id).title, meeting.title, "失败不许改标题");
  const after = rows("SELECT status, result_type, result_markdown, error_message FROM meeting_llm_results WHERE meeting_id = ?", meeting.id);
  assert.equal(after.length, rowsBefore + 1, "失败也要落一行记账");
  const failed = after.find((row) => row.status === "failed");
  assert.ok(failed, "必须有一行 status=failed");
  assert.equal(failed.result_type, "title");
  assert.equal(failed.result_markdown, "");
  assert.match(failed.error_message, /LLM API error: 500/);
  const audit = one(
    "SELECT result, error_message FROM audit_logs WHERE resource_id = ? AND action_type = 'llm.title' AND result = 'failed'",
    meeting.id
  );
  assert.ok(audit, "失败也要写审计（result=failed）");

  store.setLlmTransport(null);
  console.log("[T5] 失败路径不改标题 + 记账/审计 OK");
});

// ---------------------------------------------------------------------------
// T6 清洗兜底（模型只回了引号）
// ---------------------------------------------------------------------------

test("T6 模型只回引号/空壳 → 标题退回原名，绝不改成空串", async () => {
  const meeting = createMeetingWithSegments(buildLongTranscriptSegments(), "兜底用例原标题");
  installTransport(() => ({ text: chatCompletionBody("“”") }));

  const result = await store.runWithActor(ADMIN, () => store.generateMeetingTitle(meeting.id));
  assert.equal(result.title, meeting.title, "清洗后为空必须退回原名");
  assert.equal(one("SELECT title FROM meetings WHERE id = ?", meeting.id).title, meeting.title);
  assert.notEqual(one("SELECT title FROM meetings WHERE id = ?", meeting.id).title, "");

  // 完全空 content → 直接算失败（不留一条空标题的成功记账）
  installTransport(() => ({ text: chatCompletionBody("   ") }));
  await assert.rejects(
    () => store.runWithActor(ADMIN, () => store.generateMeetingTitle(meeting.id)),
    /LLM returned empty title/
  );
  assert.equal(one("SELECT title FROM meetings WHERE id = ?", meeting.id).title, meeting.title);

  store.setLlmTransport(null);
  console.log("[T6] 空输出兜底 OK");
});

// ---------------------------------------------------------------------------
// T7 并发点击
// ---------------------------------------------------------------------------

test("T7 并发点击：两个都成功，后者覆盖前者，不留半更新状态", async () => {
  const meeting = createMeetingWithSegments(buildLongTranscriptSegments(), "并发用例原标题");
  installTransport((call, index) => ({
    text: chatCompletionBody(index === 1 ? "并发标题甲" : "并发标题乙"),
  }));

  const [first, second] = await Promise.all([
    store.runWithActor(ADMIN, () => store.generateMeetingTitle(meeting.id)),
    store.runWithActor(ADMIN, () => store.generateMeetingTitle(meeting.id)),
  ]);

  const finalTitle = one("SELECT title FROM meetings WHERE id = ?", meeting.id).title;
  assert.ok(
    [first.title, second.title].includes(finalTitle),
    `最终标题应是其中之一，实际「${finalTitle}」`
  );
  assert.notEqual(finalTitle, meeting.title);
  assert.notEqual(finalTitle, "");

  const succeeded = rows(
    "SELECT id, result_title FROM meeting_llm_results WHERE meeting_id = ? AND result_type = 'title' AND status = 'succeeded'",
    meeting.id
  );
  assert.equal(succeeded.length, 2, "两次点击各落一条成功记账");
  // 版本号不重复（事务内取号）
  const versions = rows("SELECT version_no FROM meeting_llm_results WHERE meeting_id = ?", meeting.id).map((row) => row.version_no);
  assert.equal(new Set(versions).size, versions.length, "版本号不许重复");

  store.setLlmTransport(null);
  console.log(`[T7] 并发点击 OK（最终「${finalTitle}」）`);
});

// ---------------------------------------------------------------------------
// T8 越权
// ---------------------------------------------------------------------------

test("T8 别人的会议 → 404，且不动任何数据", async () => {
  const meeting = createMeetingWithSegments(buildLongTranscriptSegments(), "越权用例原标题");

  const other = await store.runWithActor(ADMIN, () =>
    store.createUser({
      accountName: "ai-title-other",
      displayName: "另一个人",
      email: "",
      department: "",
      status: "active",
      roleKeys: ["user"],
      initialPassword: "Passw0rd!2345",
    })
  );
  assert.ok(other?.id);
  const otherActor = store.getActorByAccountName("ai-title-other");
  assert.ok(otherActor);

  installTransport(() => ({ text: chatCompletionBody("不该出现的标题") }));

  await assert.rejects(
    () => store.runWithActor(otherActor, () => store.generateMeetingTitle(meeting.id)),
    (error) => {
      assert.equal(error.name, "AiTitleError");
      assert.equal(error.status, 404, "非本人的会议按既有口径 404");
      return true;
    }
  );

  assert.equal(transportCalls.length, 0, "越权请求不许打到 LLM");
  assert.equal(one("SELECT title FROM meetings WHERE id = ?", meeting.id).title, meeting.title);
  assert.equal(rows("SELECT id FROM meeting_llm_results WHERE meeting_id = ?", meeting.id).length, 0);

  store.setLlmTransport(null);
  console.log("[T8] 越权 404 OK");
});

// ---------------------------------------------------------------------------
// T9 UI 接线（源码级防回归，不起浏览器）
//
// 断言的是**真实源码**里的接线：AI 改名/撤销必须只走一个投影函数
// （#43 R2 的教训：列表行走 setSelected(m)、详情走 loadMeetingFull()，两处不是一个来源
// 就会出现「详情有、列表点进去没有」），两个入口都要在，toast 要带撤销动作。
// 真机浏览器验证由主 agent 在部署后的 :3123 做（见交付报告 ## 未验证）。
// ---------------------------------------------------------------------------

function sliceBetween(source, startNeedle, endNeedle, fileLabel) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `${fileLabel} 里找不到起点: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `${fileLabel} 里找不到终点: ${endNeedle}`);
  return source.slice(start, end);
}

test("T9 UI 接线：列表/详情两个入口 + 撤销 + 共用投影函数", () => {
  const pagePath = join(repoRoot, "src", "app", "page.tsx");
  const historyPath = join(repoRoot, "src", "components", "main", "HistoryList.tsx");
  const routePath = join(repoRoot, "src", "app", "api", "meetings", "[id]", "ai-title", "route.ts");
  const pageSource = readFileSync(pagePath, "utf-8");
  const historySource = readFileSync(historyPath, "utf-8");
  const routeSource = readFileSync(routePath, "utf-8");

  // 1) 共享投影函数：一次投影同时落到列表行与选中详情
  const projection = sliceBetween(
    pageSource,
    "const applyMeetingProjection = useCallback(",
    "const handleUndoAiTitle",
    "page.tsx"
  );
  assert.match(projection, /setMeetings\(/, "投影必须更新列表行");
  assert.match(projection, /setSelected\(/, "投影必须更新选中详情");

  // 2) 成功路径与撤销路径都走这个函数，不许各自拼一套 setState
  const undoBody = sliceBetween(pageSource, "const handleUndoAiTitle = useCallback(", "const handleGenerateAiTitle", "page.tsx");
  assert.match(undoBody, /applyMeetingProjection\(data\.meeting\)/, "撤销必须回滚 UI 状态（同一个投影）");
  assert.match(undoBody, /method: "PATCH"/, "撤销走既有 PATCH /api/meetings/:id 改回原标题");
  assert.doesNotMatch(undoBody, /setSelected\(|setMeetings\(/, "撤销不许绕过投影函数直接改 state");

  const generateBody = sliceBetween(pageSource, "const handleGenerateAiTitle = useCallback(", "// R2 修 F2", "page.tsx");
  assert.match(generateBody, /\/ai-title`/, "必须调用新增的 AI 标题接口");
  assert.match(generateBody, /applyMeetingProjection\(meeting\)/, "成功后必须走共享投影");
  assert.doesNotMatch(generateBody, /setSelected\(|setMeetings\(/, "成功路径不许绕过投影函数直接改 state");
  assert.match(generateBody, /label: "撤销"/, "toast 必须提供一次撤销");
  assert.match(generateBody, /setAiTitleLoadingId\(meetingId\)/, "点击后按钮要进 loading");

  // 3) 两个入口：历史列表项 + 详情页
  assert.match(pageSource, /onAiTitle=\{\(id\) =>/, "历史列表入口要接线");
  assert.match(pageSource, /data-testid="ai-title-detail"/, "详情页入口要在");
  assert.match(historySource, /data-testid=\{`ai-title-list-\$\{m\.id\}`\}/, "列表项按钮要在");
  assert.match(historySource, /onAiTitle\(m\.id\)/, "列表项按钮要触发 AI 起标题");
  assert.match(historySource, /aiTitleLoadingId === m\.id/, "列表项按钮要有 loading 态");

  // 4) toast 渲染撤销按钮（notice.action）
  assert.match(pageSource, /notice\.action &&/, "toast 要渲染 action 按钮");
  assert.match(pageSource, /notice\.action\.label/, "toast 动作文案来自 notice.action");

  // 5) 接口鉴权与既有会议接口一致（BUSINESS_ROLES），失败按 AiTitleError.status 映射
  assert.match(routeSource, /withRequiredRoles\(req, BUSINESS_ROLES/, "鉴权口径必须与既有会议接口一致");
  assert.match(routeSource, /error instanceof AiTitleError \? error\.status : 500/, "错误码按 AiTitleError.status 映射");
  console.log("[T9] UI 接线（两个入口 / 共用投影 / 撤销）OK");
});
