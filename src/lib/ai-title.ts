/**
 * 会议 AI 标题（feat-261101-04 / GitHub #44）
 *
 * 本文件只放**可单测的纯函数**与常量：不 import 任何运行时模块（`DatabaseSync` 是
 * type-only import，编译期擦除），因此 `scripts/ai-title-test.mjs` 可以直接 import
 * 真实源码做断言，不需要 mock 整个 admin-store。
 *
 * 三块职责：
 *   1. `sanitizeMeetingTitle` —— LLM 输出清洗（引号/换行/首尾标点/空白/长度上限/空兜底）；
 *   2. `buildTitlePrompt`     —— 送模型的正文窗口（1 小时会议几万字，绝不整段塞 prompt）；
 *   3. `ensureTitleTemplate`  —— `tpl-title` 模板的**无条件**插入（老库无种子也要有）。
 *
 * 红线：长度按**字符（码点）**算，不按字节；清洗后绝不允许返回空串。
 */
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// 模板常量：tpl-title（key = system_title，type = title）
// ---------------------------------------------------------------------------

export const TITLE_TEMPLATE_ID = "tpl-title";
export const TITLE_TEMPLATE_KEY = "system_title";
export const TITLE_TEMPLATE_TYPE = "title";
export const TITLE_TEMPLATE_NAME = "会议标题生成";
export const TITLE_TEMPLATE_DESCRIPTION = "系统内置 AI 标题模板：由转写内容生成不超过 30 字的会议标题（feat-261101-04）";

export const TITLE_TEMPLATE_CONTENT = [
  "你是会议标题助手。请阅读下面的会议转写内容，用不超过 30 个汉字概括这场会议的主题。",
  "只输出标题本身：不要引号、不要书名号、不要句末标点、不要解释、不要换行、不要 Markdown 标记。",
  "",
  "会议转写内容：",
  "{transcript}",
].join("\n");

/** 会议标题长度上限（按字符数，不是字节数）。 */
export const TITLE_MAX_CHARS = 30;
/** 送模型的正文上限（字符）。1 小时会议正文约 3~5 万字，超出按「开头 + 结尾」窗口截断。 */
export const TITLE_TRANSCRIPT_MAX_CHARS = 6000;
/** 窗口里开头部分占比（会议主题通常在开头交代，结尾常带结论）。 */
export const TITLE_TRANSCRIPT_HEAD_RATIO = 0.7;
/** 清洗后仍为空时的兜底标题（绝不允许把会议名改成空串）。 */
export const TITLE_FALLBACK_TITLE = "未命名会议";
/** 记账用：`meeting_llm_results.result_type`。 */
export const TITLE_RESULT_TYPE = "title";

// ---------------------------------------------------------------------------
// 错误类型：路由层按 status 映射 HTTP 码（未授权由 withRequiredRoles 处理，
// 这里只管「会议不存在/不属于当前用户」= 404、「没有转写」= 409）
// ---------------------------------------------------------------------------

export class AiTitleError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AiTitleError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 输出清洗
// ---------------------------------------------------------------------------

/** 成对引号：成对出现时先整体剥掉，再交给边缘装饰清理。 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["《", "》"],
  ["〈", "〉"],
  ["【", "】"],
  ["`", "`"],
];

/**
 * 首尾允许剥掉的「装饰」字符：空白 + 中英文标点 + 括号 + Markdown 标记。
 * 注意只剥**首尾**，中间（如「Q3 目标：复盘」里的冒号）保留。
 */
const EDGE_DECORATIONS = " \t\r\n\u3000\"'“”‘’「」『』《》〈〉【】[]()（）{}<>，。、；：？！,.;:?!~～…—－·-–—_*#|";
const EDGE_DECORATION_SET = new Set(Array.from(EDGE_DECORATIONS));

function trimEdgeDecorations(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && EDGE_DECORATION_SET.has(chars[start])) start += 1;
  while (end > start && EDGE_DECORATION_SET.has(chars[end - 1])) end -= 1;
  return chars.slice(start, end).join("");
}

function stripWrappingQuotes(text: string): string {
  let current = text;
  for (let round = 0; round < 4; round += 1) {
    let matched = false;
    for (const [open, close] of QUOTE_PAIRS) {
      if (current.length <= open.length + close.length) continue;
      if (!current.startsWith(open) || !current.endsWith(close)) continue;
      const inner = current.slice(open.length, current.length - close.length).trim();
      if (!inner) continue;
      current = inner;
      matched = true;
      break;
    }
    if (!matched) break;
  }
  return current;
}

/** 按**码点**算长度（emoji / 生僻字不会被算成 2 个字符）。 */
export function titleCharCount(text: string): number {
  return Array.from(text).length;
}

/**
 * 清洗 LLM 返回的标题。
 *
 * 顺序（与工单一致）：去换行 → 压缩连续空白 → 去「标题：」前缀 → 去包裹引号 →
 * 去首尾标点与空白 → 截到 `maxChars` 个字符 → 再清一次首尾装饰。
 *
 * @param raw      LLM 原始输出（任何类型都接受，非字符串按 String() 兜底）
 * @param fallback 清洗后为空时使用（通常是会议原名）；`fallback` 也空则用「未命名会议」
 * @returns 一定非空、长度 ≤ `maxChars`、无首尾标点/引号/换行的标题
 */
export function sanitizeMeetingTitle(
  raw: unknown,
  fallback: string = TITLE_FALLBACK_TITLE,
  maxChars: number = TITLE_MAX_CHARS
): string {
  const source = raw === null || raw === undefined ? "" : String(raw);
  let text = source
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 「标题：xxx」/「会议主题: xxx」这类前缀
  text = text.replace(/^(?:会议)?(?:标题|题目|主题)\s*[:：]\s*/, "").trim();
  text = stripWrappingQuotes(text);
  text = trimEdgeDecorations(text);

  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : TITLE_MAX_CHARS;
  const chars = Array.from(text);
  if (chars.length > limit) {
    // 截断后再清一次：被切掉的可能正好是尾部标点，也可能切出「标题：」
    text = trimEdgeDecorations(chars.slice(0, limit).join(""));
  }

  if (text) return text;

  const fallbackText = trimEdgeDecorations(
    stripWrappingQuotes(String(fallback ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim())
  );
  return fallbackText || TITLE_FALLBACK_TITLE;
}

// ---------------------------------------------------------------------------
// 送模型的正文窗口（截断 / 分段）
// ---------------------------------------------------------------------------

export type TitleTranscriptWindow = {
  /** 实际塞进 prompt 的正文 */
  text: string;
  /** 原始正文总字符数 */
  totalChars: number;
  /** 实际送出的正文字符数（不含省略标记） */
  sentChars: number;
  truncated: boolean;
  headChars: number;
  tailChars: number;
  omittedChars: number;
};

/**
 * 把会议正文压到 `maxChars` 字符以内：**开头 70% + 结尾 30%**，中间用省略标记替代。
 *
 * 为什么不是整段塞进去：1 小时会议正文几万字，全塞会撑爆上下文、拖长首字延迟，
 * 且标题只需要主题信息。为什么不逐段多次调用 LLM：标题是「一句话概括」，
 * 多段汇总要多花 N 倍调用与 N 倍排队时间，收益不成正比（见 docs/design/ai-title.md）。
 */
export function selectTitleTranscript(
  transcript: string,
  maxChars: number = TITLE_TRANSCRIPT_MAX_CHARS
): TitleTranscriptWindow {
  const normalized = String(transcript ?? "")
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(normalized);
  const totalChars = chars.length;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : TITLE_TRANSCRIPT_MAX_CHARS;

  if (totalChars <= limit) {
    return {
      text: normalized,
      totalChars,
      sentChars: totalChars,
      truncated: false,
      headChars: totalChars,
      tailChars: 0,
      omittedChars: 0,
    };
  }

  const headChars = Math.max(1, Math.ceil(limit * TITLE_TRANSCRIPT_HEAD_RATIO));
  const tailChars = Math.max(0, limit - headChars);
  const head = chars.slice(0, headChars).join("");
  const tail = tailChars > 0 ? chars.slice(totalChars - tailChars).join("") : "";
  const omittedChars = totalChars - headChars - tailChars;
  const marker = `\n……（会议过长，中间省略 ${omittedChars} 字）……\n`;

  return {
    text: `${head}${marker}${tail}`,
    totalChars,
    sentChars: headChars + tailChars,
    truncated: true,
    headChars,
    tailChars,
    omittedChars,
  };
}

export type TitlePrompt = TitleTranscriptWindow & {
  prompt: string;
  templateChars: number;
};

/** 把正文窗口填进模板的 `{transcript}`（模板里没有占位符时追加在末尾）。 */
export function buildTitlePrompt(
  templateContent: string,
  transcript: string,
  maxChars: number = TITLE_TRANSCRIPT_MAX_CHARS
): TitlePrompt {
  const window = selectTitleTranscript(transcript, maxChars);
  const template = String(templateContent ?? "");
  const prompt = template.includes("{transcript}")
    ? template.replaceAll("{transcript}", window.text)
    : `${template}\n\n会议转写内容：\n${window.text}`;
  return { ...window, prompt, templateChars: titleCharCount(template) };
}

// ---------------------------------------------------------------------------
// 模板种子：tpl-title 必须**无条件**存在
// ---------------------------------------------------------------------------

/**
 * 无条件确保 `tpl-title` 存在（老库里 `seedDefaults` 的 `if (templateCount === 0)`
 * 整块不会跑，只靠种子会拿不到模板）。
 *
 * 语义：**已有同名模板（`id = tpl-title` 或 `template_key = system_title`）就不动它**
 * （用户可能改过内容），缺失才插入。与 `upsertPromptTemplate` 的覆盖式 upsert 不同，
 * 所以这里不复用那个函数。
 *
 * @returns "inserted" = 本次插入了；"kept" = 已存在，保持原样
 */
export function ensureTitleTemplate(database: DatabaseSync, now: string): "inserted" | "kept" {
  const result = database
    .prepare(`
      INSERT INTO llm_prompt_templates (
        id, template_key, template_name, template_type, content, description, status, is_system, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM llm_prompt_templates WHERE id = ? OR template_key = ?
      )
    `)
    .run(
      TITLE_TEMPLATE_ID,
      TITLE_TEMPLATE_KEY,
      TITLE_TEMPLATE_NAME,
      TITLE_TEMPLATE_TYPE,
      TITLE_TEMPLATE_CONTENT,
      TITLE_TEMPLATE_DESCRIPTION,
      now,
      now,
      TITLE_TEMPLATE_ID,
      TITLE_TEMPLATE_KEY
    );

  return Number(result.changes ?? 0) > 0 ? "inserted" : "kept";
}
