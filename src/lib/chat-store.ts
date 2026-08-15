// 语音对话：会话内存管理与 LLM 流式调用（M3）
//
// 设计约束（对齐 docs/design/llm-generation-pipeline.md）：
//   - 原生 node:http/https 而非全局 fetch（undici 300s headersTimeout 不可控）
//   - SSE 流式（stream: true）绕开 nginx proxy_read_timeout
//   - LLM 配置来自 app_settings(llm 段)，不写死
//   - 会话 V1 纯内存（开放问题 1：不落库），LRU + TTL 防泄漏

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { getSettingValue } from "@/lib/admin-store";
import { llmQueue } from "@/lib/llm-queue";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// ---------- 会话存储（内存） ----------

const MAX_CONVERSATIONS = 50;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 6000;
const SYSTEM_PROMPT =
  "你是智能会议纪要系统的语音对话助手。用简洁、口语化的中文回答用户问题。" +
  "要求：1) 回复适合语音朗读，纯文本，不要使用任何 markdown 符号、编号、表情符号；" +
  "2) 一次回复控制在 3 句话以内（约 100 字）；" +
  "3) 内容与会议纪要、转写、翻译、语音识别相关时优先结合上下文回答；" +
  "4) 不知道时直接说明，不要编造。";

interface Conversation {
  id: string;
  messages: ChatMessage[];
  lastAt: number;
}

const conversations = new Map<string, Conversation>();

export function createConversation(): string {
  const id =
    `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  conversations.set(id, { id, messages: [], lastAt: Date.now() });
  evictConversations();
  return id;
}

export function getConversation(id: string): Conversation | null {
  const conversation = conversations.get(id);
  if (!conversation) return null;
  if (Date.now() - conversation.lastAt > CONVERSATION_TTL_MS) {
    conversations.delete(id);
    return null;
  }
  conversation.lastAt = Date.now();
  return conversation;
}

export function deleteConversation(id: string): boolean {
  return conversations.delete(id);
}

export function listConversationMessages(id: string): ChatMessage[] {
  const conversation = getConversation(id);
  return conversation ? [...conversation.messages] : [];
}

function evictConversations() {
  if (conversations.size <= MAX_CONVERSATIONS) return;
  const sorted = [...conversations.values()].sort((a, b) => b.lastAt - a.lastAt);
  for (const item of sorted.slice(MAX_CONVERSATIONS)) {
    conversations.delete(item.id);
  }
}

// 追加消息并裁剪历史（保留最近 N 条 + 总字数上限）
function appendMessage(conversationId: string, role: ChatRole, content: string) {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  conversation.messages.push({ role, content });
  let chars = conversation.messages.reduce((sum, m) => sum + m.content.length, 0);
  while (conversation.messages.length > MAX_HISTORY_MESSAGES || chars > MAX_HISTORY_CHARS) {
    const removed = conversation.messages.shift();
    if (!removed) break;
    chars -= removed.content.length;
  }
}

// ---------- LLM 流式调用 ----------

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  onDone: (content: string, finishReason: string) => void;
  onError: (error: Error) => void;
}

export interface ChatStreamResult {
  content: string;
  finishReason: string;
}

const CHAT_TIMEOUT_MS = 180_000;

function readLlmConfig() {
  const baseUrl = getSettingValue("llm", "base_url");
  const apiKey = getSettingValue("llm", "api_key");
  const model = getSettingValue("llm", "model");
  const timeoutRaw = getSettingValue("llm", "timeout_ms");
  if (!baseUrl || !model) throw new Error("LLM 配置不完整，请先在系统管理中配置 base_url 和 model");
  const timeoutMs = Number(timeoutRaw);
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CHAT_TIMEOUT_MS,
  };
}

function buildThinkingParams(): Record<string, unknown> {
  if (getSettingValue("llm", "thinking_model") === "0") return {};
  return {
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
    think: false,
  };
}

function parseSseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return { done: true as const };
  try {
    return { parsed: JSON.parse(data) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function llmChatRequest(
  endpoint: string,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onChunk: (chunk: string) => void
): Promise<{ status: number; finishReason: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const isHttps = u.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;

    const req = transport(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : isHttps ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers,
      },
      (res) => {
        if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            reject(new Error(`LLM API error: ${res.statusCode} ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`));
          });
          return;
        }
        res.on("data", (chunk) => onChunk(Buffer.from(chunk).toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, finishReason: "" }));
        res.on("error", (err) => reject(new Error(`LLM response read failed: ${err.message}`, { cause: err })));
      }
    );

    req.on("error", (err) => reject(new Error(`LLM 网络错误: ${err.message}`, { cause: err })));

    const onAbort = () => {
      req.destroy();
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      reject(abortError);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    req.write(body);
    req.end();
  });
}

/**
 * 发起一轮对话：追加 user 消息 → LLM 流式 → 追加 assistant 消息 → 返回完整内容。
 * 通过 llmQueue 串行排队（与纪要/翻译共享容量，避免打爆 llama.cpp）。
 */
export async function runChatStream(
  conversationId: string,
  userMessage: string,
  callbacks: ChatStreamCallbacks
): Promise<ChatStreamResult> {
  return llmQueue.enqueue("chat", async () => {
    const conversation = getConversation(conversationId);
    if (!conversation) throw new Error("会话不存在或已过期");
    const { baseUrl, apiKey, model, timeoutMs } = readLlmConfig();

    const trimmed = userMessage.trim();
    appendMessage(conversationId, "user", trimmed);

    const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let rawText = "";
    let content = "";
    let reasoning = "";
    let finishReason = "stop";

    try {
      const payload = JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...conversation.messages.slice(0, -1), // 历史（不含刚追加的 user，避免重复）
          { role: "user", content: trimmed },
        ],
        temperature: 0.6,
        stream: true,
        ...buildThinkingParams(),
      });

      await llmChatRequest(
        endpoint,
        payload,
        {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        controller.signal,
        (chunk) => {
          rawText += chunk;
          // 逐行解析（chunk 可能含多行，行可能跨 chunk）
          const lines = rawText.split("\n");
          rawText = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseSseLine(line);
            if (!parsed) continue;
            if ("done" in parsed) {
              finishReason = "stop";
              continue;
            }
            if (!parsed.parsed) continue;
            const delta = parsed.parsed as {
              choices?: Array<{
                delta?: { content?: string; reasoning_content?: string };
                finish_reason?: string | null;
              }>;
            };
            const choice = delta.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = String(choice.finish_reason);
            const deltaContent = choice.delta?.content;
            if (typeof deltaContent === "string" && deltaContent) {
              content += deltaContent;
              callbacks.onDelta(deltaContent);
            }
            const reasoningContent = choice.delta?.reasoning_content;
            if (typeof reasoningContent === "string" && reasoningContent) {
              reasoning += reasoningContent;
              callbacks.onReasoning?.(reasoningContent);
            }
          }
        }
      );

      if (!content) {
        throw new Error(finishReason === "length" ? "LLM 回复为空（finishReason=length）" : "LLM 返回空内容");
      }

      appendMessage(conversationId, "assistant", content);
      callbacks.onDone(content, finishReason);
      return { content, finishReason };
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}
