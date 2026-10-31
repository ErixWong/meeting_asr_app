/**
 * TTS 纯函数单测（node --test）
 *
 * 覆盖 server/tts-gateway.mjs 的 splitSentences / detectTextLang，
 * 以及 src/lib/chat-client.ts 的 extractCompleteSentences（流式增量断句）。
 *
 * 运行：npm run test:tts（= node --test scripts/tts-test.mjs，需 Node 24）
 * 说明：chat-client.ts 是 TS 且无外部 import，先用 tsc 编译到临时目录再 import。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { splitSentences, detectTextLang } from "../server/tts-gateway.mjs";

// ---------- extractCompleteSentences（TS → 临时 JS） ----------

const compileDir = mkdtempSync(join(tmpdir(), "tts-test-chat-client-"));

function compileChatClient() {
  const tsc = spawnSync(
    "npx",
    [
      "tsc",
      resolve("src/lib/chat-client.ts"),
      "--outDir",
      compileDir,
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--skipLibCheck",
    ],
    { encoding: "utf-8" }
  );
  if (tsc.status !== 0) {
    throw new Error(`tsc 编译 chat-client.ts 失败: ${tsc.stdout ?? ""}${tsc.stderr ?? ""}`);
  }
  return import(pathToFileURL(join(compileDir, "chat-client.js")).href);
}

const chatClient = await compileChatClient();
const { extractCompleteSentences } = chatClient;

process.on("exit", () => {
  rmSync(compileDir, { recursive: true, force: true });
});

// ---------- detectTextLang ----------

test("detectTextLang: 中英夹杂判 zh（审查实测的 6 条基线）", () => {
  // 这两条是审查时实测会翻车的用例（旧实现按字符占比算 → 判成 en → 选错音色）
  assert.equal(detectTextLang("我们 review 一下 PR 的 deploy 流程"), "zh");
  assert.equal(detectTextLang("hello 你好"), "zh");
  // 下面四条旧实现就是对的，锁住不回退
  assert.equal(detectTextLang("hello world this is english"), "en");
  assert.equal(detectTextLang("こんにちは、よろしく"), "ja");
  assert.equal(detectTextLang("唔该你帮我做下嘢嘅"), "yue");
  assert.equal(detectTextLang("这是中文会议内容"), "zh");
});

test("detectTextLang: en 只在零汉字/零假名/零韩文且拉丁词数 >= 3 时成立", () => {
  assert.equal(detectTextLang("Let us review the deploy flow"), "en");
  assert.equal(detectTextLang("yes"), "zh"); // 1 个词，太短不敢判 en
  assert.equal(detectTextLang("ok sure"), "zh"); // 2 个词
  assert.equal(detectTextLang("ok sure fine"), "en"); // 3 个词
  assert.equal(detectTextLang("我今天用 Deploy 流程"), "zh");
});

test("detectTextLang: 空串/纯标点/纯数字回退 zh", () => {
  assert.equal(detectTextLang(""), "zh");
  assert.equal(detectTextLang(null), "zh");
  assert.equal(detectTextLang("123 ，。！"), "zh");
});

// ---------- splitSentences ----------

test("splitSentences: 中文标点分句", () => {
  assert.deepEqual(splitSentences("第一句。第二句！第三句？"), ["第一句。", "第二句！", "第三句？"]);
  assert.deepEqual(splitSentences("分号也算；省略号也切……后面还有"), [
    "分号也算；",
    "省略号也切…",
    "…",
    "后面还有",
  ]);
});

test("splitSentences: 缩写不误切", () => {
  assert.deepEqual(splitSentences("Mr. Smith is here."), ["Mr. Smith is here."]);
  assert.deepEqual(splitSentences("The U.S. market is big."), ["The U.S. market is big."]);
  assert.deepEqual(splitSentences("e.g. this one. Next one."), ["e.g. this one.", "Next one."]);
});

test("splitSentences: 数字点与版本号不误切", () => {
  assert.deepEqual(splitSentences("Pi is 3.14 here."), ["Pi is 3.14 here."]);
  assert.deepEqual(splitSentences("Upgrade to v1.2.3 now."), ["Upgrade to v1.2.3 now."]);
});

test("splitSentences: 半角 !?; 与换行也分句", () => {
  assert.deepEqual(splitSentences("Really? Yes! Done;"), ["Really?", "Yes!", "Done;"]);
  assert.deepEqual(splitSentences("line one\nline two"), ["line one", "line two"]);
});

test("splitSentences: 空输入返回空数组", () => {
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("   "), []);
  assert.deepEqual(splitSentences(null), []);
});

// ---------- extractCompleteSentences（流式增量） ----------

test("extractCompleteSentences: 只切出完整句，尾巴原样留作 rest", () => {
  const r1 = extractCompleteSentences("I agree. The U.S.");
  assert.deepEqual(r1.sentences, ["I agree."]);
  assert.equal(r1.rest, " The U.S.");

  const r2 = extractCompleteSentences("第三句话还没说完");
  assert.deepEqual(r2.sentences, []);
  assert.equal(r2.rest, "第三句话还没说完");
});

test("extractCompleteSentences: 缓冲被截在缩写中间会切出半个缩写（已知流式边界代价）", () => {
  // 流式缓冲区在 "The U." 处截断时，ABBR_RE 匹配不到 "U.S." 整体 → 会切出 "The U."。
  // 这是增量断句的固有代价（下一个 delta 补全前无法知道它其实是个缩写），
  // 只会多合成一小句、不会丢字，故允许保持现状；此用例仅钉住行为，改动须同步更新这里。
  const r = extractCompleteSentences("The U.");
  assert.deepEqual(r.sentences, ["The U."]);
  assert.equal(r.rest, "");
});

test("extractCompleteSentences: 缩写完整时正常保护，多句逐个切出", () => {
  const r = extractCompleteSentences("Mr. Smith agrees. 好。尾巴");
  assert.deepEqual(r.sentences, ["Mr. Smith agrees.", " 好。"]);
  assert.equal(r.rest, "尾巴");
});
