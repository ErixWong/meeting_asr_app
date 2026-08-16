"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, extractCompleteSentences, createTtsPlayer, type TtsPlayer } from "@/lib/chat-client";
import ChatVoiceButton from "@/components/chat/ChatVoiceButton";

type MessageStatus = "streaming" | "done";

interface ChatMessageItem {
  id: number;
  role: "user" | "assistant";
  text: string;
  status: MessageStatus;
  synthError?: boolean;
}

let messageCounter = 0;
const nextId = () => ++messageCounter;

/**
 * 语音对话面板：多轮上下文（服务端会话）、LLM 流式文字 + 增量断句 TTS 合成播放、
 * 打断（新输入停止当前播放与生成）、清空会话。
 */
export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [playerState, setPlayerState] = useState<"idle" | "playing">("idle");
  const [notice, setNotice] = useState("");
  // 错误降级：TTS 容器健康状态（不可用时仅显示文字并提示）
  const [ttsOk, setTtsOk] = useState<boolean | null>(null);
  const conversationIdRef = useRef<string>("");
  const playerRef = useRef<TtsPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  // 流式断句 TTS 状态
  const restRef = useRef("");
  const ttsChainRef = useRef<Promise<void>>(Promise.resolve());

  if (!playerRef.current) {
    const player = createTtsPlayer();
    player.onStateChange = (state) => setPlayerState(state);
    playerRef.current = player;
  }

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    // 进入对话页即探测 TTS 容器可用性（错误降级提示）
    let cancelled = false;
    fetch("/api/tts/health")
      .then((res) => res.json())
      .then((data: { ok?: boolean }) => {
        if (!cancelled) setTtsOk(Boolean(data.ok));
      })
      .catch(() => {
        if (!cancelled) setTtsOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      playerRef.current?.stop();
    };
  }, []);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 4000);
  }, []);

  /** 合成单句并排队播放（失败不阻塞对话，仅标记）。 */
  const synthesizeSentence = useCallback(async (sentence: string, onFail: () => void) => {
    try {
      const res = await fetch("/api/tts/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence, stream: false }),
      });
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
      const wav = await res.arrayBuffer();
      if (wav.byteLength === 0) throw new Error("empty audio");
      await playerRef.current?.enqueue(wav);
    } catch (error) {
      console.warn("[Chat] TTS sentence failed (fallback: text only):", error);
      onFail();
    }
  }, []);

  const stopAll = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playerRef.current?.stop();
    restRef.current = "";
    ttsChainRef.current = Promise.resolve();
  }, []);

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || busy) return;

      // 打断：停止当前语音与生成
      stopAll();

      const userMessage: ChatMessageItem = { id: nextId(), role: "user", text, status: "done" };
      const assistantMessage: ChatMessageItem = { id: nextId(), role: "assistant", text: "", status: "streaming" };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setInput("");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const assistantTextRef = { text: "" };
      let synthFailed = false;

      const patchAssistant = (patch: Partial<ChatMessageItem>) => {
        setMessages((prev) =>
          prev.map((item) => (item.id === assistantMessage.id ? { ...item, ...patch } : item))
        );
      };

      // 流式断句：每次 delta 后切出完整句，逐句排队合成
      const consumeSentences = (delta: string) => {
        restRef.current += delta;
        const { sentences, rest } = extractCompleteSentences(restRef.current);
        restRef.current = rest;
        for (const sentence of sentences) {
          ttsChainRef.current = ttsChainRef.current
            .then(() => synthesizeSentence(sentence, () => { synthFailed = true; }))
            .catch(() => {});
        }
      };

      try {
        await streamChat({
          message: text,
          conversationId: conversationIdRef.current,
          onStart: (conversationId) => {
            conversationIdRef.current = conversationId;
          },
          onDelta: (deltaText) => {
            assistantTextRef.text += deltaText;
            patchAssistant({ text: assistantTextRef.text });
            consumeSentences(deltaText);
          },
          onDone: (fullText) => {
            assistantTextRef.text = fullText || assistantTextRef.text;
            // 残余（未成句）也合成，作为最后一句
            const rest = restRef.current.trim();
            if (rest) {
              const finalText = rest;
              restRef.current = "";
              ttsChainRef.current = ttsChainRef.current
                .then(() => synthesizeSentence(finalText, () => { synthFailed = true; }))
                .catch(() => {});
            }
            patchAssistant({ text: assistantTextRef.text, status: "done", synthError: synthFailed });
          },
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (!aborted) {
          console.error("[Chat] stream failed:", error);
          const message = error instanceof Error ? error.message : String(error);
          patchAssistant({ text: assistantTextRef.text || `（对话失败：${message}）`, status: "done" });
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, stopAll, synthesizeSentence]
  );

  const handleVoiceUtterance = useCallback(
    (text: string) => {
      if (text) void sendMessage(text);
      else showNotice("未识别到语音内容，请再说一次或直接输入文字");
    },
    [sendMessage, showNotice]
  );

  const clearConversation = useCallback(async () => {
    stopAll();
    const conversationId = conversationIdRef.current;
    conversationIdRef.current = "";
    setMessages([]);
    if (conversationId) {
      try {
        await fetch(`/api/chat?conversationId=${encodeURIComponent(conversationId)}`, { method: "DELETE" });
      } catch {
        // 清空失败不影响本地清空
      }
    }
  }, [stopAll]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      void sendMessage(input);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* 顶部工具条 */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>多轮语音对话</span>
          {busy && <span className="text-brand">· 生成中</span>}
          {playerState === "playing" && <span className="text-emerald-600">· 🔊 语音播放中</span>}
          {ttsOk === false && <span className="text-rose-500">· TTS 服务不可用，仅显示文字</span>}
          {notice && <span className="text-amber-600">· {notice}</span>}
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => void clearConversation()}
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            清空会话
          </button>
        )}
      </div>

      {/* 消息列表 */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mt-16 text-center text-sm text-slate-400">
            <p className="mb-2 text-2xl">🗣</p>
            <p>按住下方按钮说话，或输入文字与语音助手对话</p>
            <p className="mt-1 text-xs">支持多轮上下文；回复会边生成边朗读（本地 TTS 合成，按语言自动选音色）</p>
            {ttsOk === false && (
              <p className="mt-2 inline-block rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700">
                ⚠ 语音合成服务（TTS）当前不可用，对话仍可进行但不会朗读回复
              </p>
            )}
          </div>
        )}
        {messages.map((item) => (
          <div key={item.id} className={`flex ${item.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                item.role === "user"
                  ? "rounded-br-sm bg-brand text-white"
                  : "rounded-bl-sm border border-slate-200 bg-white text-slate-800"
              }`}
            >
              {item.role === "assistant" && item.status === "streaming" ? (
                <>
                  <span className="whitespace-pre-wrap">{item.text}</span>
                  <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-slate-400 align-middle" />
                </>
              ) : (
                <span className="whitespace-pre-wrap">{item.text}</span>
              )}
              {item.role === "assistant" && item.status === "done" && item.synthError && (
                <span className="ml-2 text-xs text-amber-500">（语音合成失败，仅显示文字）</span>
              )}
            </div>
          </div>
        ))}
        <div ref={listEndRef} />
      </div>

      {/* 输入区 */}
      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <ChatVoiceButton onUtterance={handleVoiceUtterance} disabled={busy} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入问题，Enter 发送"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            disabled={busy}
          />
          <button
            onClick={() => void sendMessage(input)}
            disabled={busy || !input.trim()}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
