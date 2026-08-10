// LLM 思考模式响应结构诊断（llama.cpp / Qwen3）
// 目的：验证"启用思考（不附加关闭参数）"时，思考内容到底在 reasoning_content 还是混进 content，
//       以及现有 stripLeadingThinking 后处理能否兜底
// 用法：node tests/verify-llm-thinking-structure.mjs
// 环境变量可覆盖：LLM_URL / LLM_API_KEY / LLM_MODEL
import { env } from "node:process";

const BASE_URL = env.LLM_URL || "http://cnzhe-app201.intevaproducts.com:8090";
const API_KEY = env.LLM_API_KEY || "erix-llama-key";
const MODEL = env.LLM_MODEL || "erix395/qwen3.6-35b";

const SYSTEM_PROMPT =
  "你是实时会议翻译助手。把用户发来的会议记录逐行翻译成中文。只输出译文，每行对应原文一行，不要编号、不要解释。";
const USER_TEXT = [
  "I guess he didn't realize that he was sitting across the table from a woman who had just invented a novel flu vaccine that was then slated for clinical trial, Kiz Miki Corbet picks up from the TED stage.",
  "Meanwhile, I was a researcher at the NIH Vaccine Research Center, so normally I would have gotten up and gone to my next appointment hearing an answer like that, but I kind of liked the guy.",
  "And so I stayed and I answered a few questions after getting another beer.",
].join("\n");

// 与 admin-store.ts stripLeadingThinking 一致的后处理逻辑
function stripLeadingThinking(content) {
  let cleaned = content.replace(/^\s+/, "");
  const closeTag = /<\/think\s*>/gi;
  let lastClose = -1;
  let lastCloseLen = 0;
  let tagMatch;
  while ((tagMatch = closeTag.exec(cleaned)) !== null) {
    lastClose = tagMatch.index;
    lastCloseLen = tagMatch[0].length;
  }
  if (lastClose >= 0) {
    cleaned = cleaned.slice(lastClose + lastCloseLen).replace(/^\s+/, "");
  }
  cleaned = cleaned.replace(/^<think>[\s\S]*?<\/think>\s*/i, "");
  cleaned = cleaned.replace(/^(<\/?think\s*>?\s*)+/i, "");
  cleaned = cleaned.replace(/^(?:<thinking>[\s\S]*?<\/thinking>|<reasoning>[\s\S]*?<\/reasoning>)\s*/i, "");
  cleaned = cleaned.replace(/^\[[\s\S]*?\](?:\s*\n|$)/, (match) => {
    const block = match.slice(0, match.lastIndexOf("]") + 1);
    return block.includes("\n") || block.trim() === cleaned.trim() ? "" : match;
  });
  return cleaned;
}

const POLLUTION_RE =
  /<\/?think\b|<thinking|<reasoning|Self-Correction|Check & Refine|\[Output|\[Final|\]\(Proceeds\)|\(Proceeds|\(Note:|\[Done\]|All constraints met|Output Generation|Final check of|I'?ll output|I will output|Let's (verify|check|adjust|make)|i'll go with|i will stick/i;

function truncate(text, len = 400) {
  return text.length > len ? text.slice(0, len) + "..." : text;
}

const endpoint = `${BASE_URL.replace(/\/$/, "")}/v1/chat/completions`;
console.log(`端点: ${endpoint}`);
console.log(`模型: ${MODEL}`);
console.log("请求: 无任何思考控制参数（模拟思考开启） + max_tokens=8192\n");

const startedAt = Date.now();
let res;
try {
  res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_TEXT },
      ],
      temperature: 0.3,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(180000),
  });
} catch (error) {
  console.log(`FAIL 请求异常: ${String(error)}`);
  process.exit(1);
}

const elapsedMs = Date.now() - startedAt;
console.log(`HTTP ${res.status}（耗时 ${elapsedMs}ms）`);
if (!res.ok) {
  console.log(`FAIL 非 200: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  process.exit(1);
}

const data = await res.json();
const choice = data.choices?.[0];
const message = choice?.message ?? {};
const usage = data.usage ?? {};

console.log("\n===== message 字段清单 =====");
console.log(`message 键: ${Object.keys(message).join(", ") || "(空对象)"}`);

const content = typeof message.content === "string" ? message.content : "";
const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
const contentTokens = Number(usage.completion_tokens ?? "?");

console.log(`\n===== 结构诊断 =====`);
console.log(`finish_reason: ${choice?.finish_reason ?? "N/A"}`);
console.log(`completion_tokens: ${contentTokens}`);
console.log(`content 长度: ${content.length} 字符`);
console.log(`reasoning_content 长度: ${reasoning.length} 字符`);

if (reasoning.length > 0) {
  console.log(`\n----- reasoning_content 前 500 字 -----`);
  console.log(truncate(reasoning, 500));
  console.log(`----- reasoning_content 末尾 200 字 -----`);
  console.log(truncate(reasoning.slice(-200), 200));
}

console.log(`\n----- content 全文（长度 ${content.length}）-----`);
console.log(content.length > 0 ? content : "(空)");

console.log("\n===== 结论分析 =====");
const hasReasoning = reasoning.length > 0;
const contentHasThinkTag = /<think|<thinking|<reasoning/i.test(content);
const contentPolluted = POLLUTION_RE.test(content);
const contentHasTranslation = /[\u4e00-\u9fff]/.test(content) && content.length > 20;

console.log(`思考内容是否单独在 reasoning_content: ${hasReasoning ? "是" : "否"}`);
console.log(`content 是否含 think 类标签: ${contentHasThinkTag ? "是" : "否"}`);
console.log(`content 是否含思考流污染标记: ${contentPolluted ? "是" : "否"}`);
console.log(`content 是否含译文: ${contentHasTranslation ? "是" : "否"}`);
if (hasReasoning && !contentHasThinkTag && !contentPolluted) {
  console.log(">>> 结论：思考内容不会混入 content，应用只读 message.content 是安全的，stripLeadingThinking 仅为兜底");
} else if (contentHasThinkTag) {
  const stripped = stripLeadingThinking(content);
  console.log(">>> 结论：思考混入了 content 且带 think 标签");
  console.log(`    stripLeadingThinking 处理后（长度 ${stripped.length}）: ${truncate(stripped, 300)}`);
  console.log(`    处理后是否干净: ${!POLLUTION_RE.test(stripped) ? "是" : "否，仍有残留"}`);
} else if (contentPolluted) {
  const stripped = stripLeadingThinking(content);
  console.log(">>> 结论：思考混入了 content 且无 think 标签");
  console.log(`    stripLeadingThinking 处理后（长度 ${stripped.length}）: ${truncate(stripped, 300)}`);
} else {
  console.log(">>> 结论：content 里既无思考也无译文（可能是空响应或全思考截断），需检查 max_tokens/finish_reason");
}
