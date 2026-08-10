// LLM 翻译输出纯净度验证（针对 Qwen3 等推理模型的思考泄漏问题）
// 直接调用 OpenAI 兼容 /chat/completions，验证关闭思考参数下返回内容不混入思考流
// 用法：
//   node tests/verify-llm-translate-output.mjs           # 默认：验证修复后参数（新代码同款）
//   node tests/verify-llm-translate-output.mjs --baseline # 对照组：三种参数对比
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

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// 几乎不可能出现在正常译文中的思考流标记（硬失败）
const POLLUTION_RE =
  /<\/?think\b|<thinking|<reasoning|Self-Correction|Check & Refine|\[Output|\[Final|\]\(Proceeds\)|\(Proceeds|\(Note:|\[Done\]|All constraints met|Output Generation|Final check of|I'?ll output|I will output|Let's (verify|check|adjust|make)|in the final version|i'll go with|i will stick/i;

// 可能误报、仅提示不计失败的可疑标记
const SUSPICIOUS_RE = /^(?:Actually|Better|Note)[,:：]|^Final:|—— 中文翻译|^\d+\.\s+\*\*/m;

function countLines(text) {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function truncate(text, len = 200) {
  return text.length > len ? text.slice(0, len) + "..." : text;
}

async function chatCompletions(endpoint, extraParams) {
  const res = await fetch(endpoint, {
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
      ...extraParams,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    return { status: res.status, error: errorText.slice(0, 300) };
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  return {
    status: res.status,
    finishReason: data.choices?.[0]?.finish_reason ?? null,
    content: typeof message.content === "string" ? message.content : "",
    reasoningContent: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
  };
}

async function resolveEndpoint() {
  const candidates = [
    `${BASE_URL.replace(/\/$/, "")}/v1/chat/completions`,
    `${BASE_URL.replace(/\/$/, "")}/chat/completions`,
  ];
  for (const endpoint of candidates) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.status !== 404) return endpoint;
    } catch {
      // 尝试下一个候选路径
    }
  }
  return null;
}

const endpoint = await resolveEndpoint();
check("探测到可用的 /chat/completions 端点", endpoint !== null, `base=${BASE_URL} model=${MODEL}`);
if (!endpoint) {
  console.log("端点不可达，无法继续");
  process.exit(1);
}
console.log(`端点: ${endpoint}`);

const cases = [
  {
    name: "新代码同款（enable_thinking + chat_template_kwargs + think）",
    extra: {
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
      think: false,
    },
  },
];

if (process.argv.includes("--baseline")) {
  cases.unshift(
    {
      name: "基线（不带任何思考控制参数，对照）",
      extra: {},
    },
    {
      name: "仅顶层 enable_thinking: false（对照）",
      extra: { enable_thinking: false },
    },
    {
      name: "仅 chat_template_kwargs: enable_thinking=false（对照）",
      extra: { chat_template_kwargs: { enable_thinking: false } },
    },
    {
      name: "仅 think: false（对照）",
      extra: { think: false },
    }
  );
}

for (const [index, item] of cases.entries()) {
  console.log(`\n===== 用例 ${index + 1}: ${item.name} =====`);
  let result;
  try {
    result = await chatCompletions(endpoint, item.extra);
  } catch (error) {
    check(`${item.name}: 请求未抛异常`, false, String(error));
    continue;
  }
  check(`${item.name}: HTTP 200`, result.status === 200, `status=${result.status}${result.error ? ` error=${result.error}` : ""}`);
  if (result.status !== 200) continue;

  const content = result.content;
  check(`${item.name}: content 非空`, content.trim().length > 0);
  if (result.reasoningContent) {
    console.log(`  reasoning_content(${result.reasoningContent.length}字): ${truncate(result.reasoningContent, 150).replace(/\n/g, "⏎")}`);
  }
  console.log(`  finish_reason=${result.finishReason ?? "N/A"}`);
  if (content.trim().length === 0) continue;

  check(
    `${item.name}: 无 think/思考流标记`,
    !POLLUTION_RE.test(content),
    truncate(content.replace(/\n/g, "⏎"), 300)
  );
  console.log(`  内容(${content.length}字, ${countLines(content)}行):`);
  console.log(`  ${truncate(content, 600).replace(/\n/g, "\n  ")}`);
  const lineCount = countLines(content);
  if (lineCount !== 3) {
    console.log(`  WARN 非空行数=${lineCount}（预期 3，可能合并/拆分行）`);
  }
  const suspicious = content.match(SUSPICIOUS_RE);
  if (suspicious) {
    console.log(`  WARN 可疑残留: ${JSON.stringify(suspicious[0])}`);
  }
  if (result.finishReason === "length") {
    console.log("  WARN finish_reason=length，输出可能被 max_tokens 截断");
  }
}

console.log(process.exitCode ? "\n验证未全部通过" : "\n全部通过");
