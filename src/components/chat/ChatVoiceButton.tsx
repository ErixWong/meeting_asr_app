"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FunASRClient } from "@/lib/funasr";

interface Props {
  /** 语音识别结束后回调解码文本（可能为空）。 */
  onUtterance: (text: string) => void;
  disabled?: boolean;
}

const MAX_HOLD_MS = 60_000;

/**
 * 按住说话：按下 → 浏览器采集 + ASR 网关实时转写（partial 实时回显）；
 * 松开 → 结束会话，取最终文本提交。松开后 600ms 内短暂可取消（未说话误触）。
 */
export default function ChatVoiceButton({ onUtterance, disabled = false }: Props) {
  const [holding, setHolding] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const clientRef = useRef<FunASRClient | null>(null);
  const finalsRef = useRef<string[]>([]);
  const partialRef = useRef("");
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releasingRef = useRef(false);
  // 启动竞态：startRecording 完成前用户已松手时标记，等连接就绪后立即结束
  const pendingReleaseRef = useRef(false);

  const cleanup = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    clientRef.current = null;
    setHolding(false);
    setPartial("");
    partialRef.current = "";
    setError("");
  }, []);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      clientRef.current?.stopRecording().catch(() => {});
    };
  }, []);

  const beginHold = useCallback(async () => {
    if (disabled || releasingRef.current || clientRef.current) return;
    releasingRef.current = true;
    pendingReleaseRef.current = false;
    finalsRef.current = [];
    partialRef.current = "";
    setPartial("");
    setError("");
    setHolding(true);

    try {
      const client = new FunASRClient();
      clientRef.current = client;
      await client.startRecording({
        onResult: (text, isFinal) => {
          if (isFinal) {
            const trimmed = text.trim();
            if (trimmed) finalsRef.current.push(trimmed);
            partialRef.current = "";
            setPartial("");
          } else {
            partialRef.current = text;
            setPartial(text);
          }
        },
        onError: (err) => {
          setError(err.message);
          cleanup();
        },
        lang: "auto",
      });
      // 超时保护：长按住自动结束
      holdTimerRef.current = setTimeout(() => {
        void finishHold();
      }, MAX_HOLD_MS);
      // 若启动期间用户已松开，立即结束（避免录音永不停止）
      if (pendingReleaseRef.current) {
        void finishHold();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      cleanup();
    } finally {
      releasingRef.current = false;
    }
  }, [cleanup, disabled]);

  const finishHold = useCallback(async () => {
    const client = clientRef.current;
    clientRef.current = null;
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (!client) return;
    setHolding(false);
    try {
      await client.stopRecording();
    } catch (err) {
      console.warn("[ChatVoice] stop failed:", err);
    }
    const finals = finalsRef.current;
    const finalText = finals.join("").trim();
    const partialText = partialRef.current.trim();
    const text = finalText || partialText || "";
    if (text) onUtterance(text);
  }, [onUtterance]);

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        disabled={disabled}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          // 捕获指针：按住期间轻微移动/按钮尺寸变化/触屏漂移不会触发 pointerleave 而误结束
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* 部分浏览器/场景不支持捕获，忽略 */
          }
          void beginHold();
        }}
        onPointerUp={() => {
          if (!clientRef.current) {
            // 录音还在启动中：标记待释放，由 beginHold 收尾
            pendingReleaseRef.current = true;
            return;
          }
          void finishHold();
        }}
        onLostPointerCapture={() => {
          // 指针捕获被系统强制释放（如浏览器中断），兜底结束
          if (!clientRef.current) return;
          void finishHold();
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={`select-none touch-none rounded-full px-5 py-2.5 text-sm font-medium shadow-sm transition disabled:opacity-40 ${
          holding
            ? "bg-red-600 text-white"
            : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        }`}
        title="按住说话（松开后自动识别发送）"
        style={{ minWidth: "9rem" }}
      >
        {holding ? "🎙 正在听…（松开发送）" : "🎙 按住说话"}
      </button>
      {holding && partial && (
        <span className="max-w-[220px] truncate text-xs text-slate-500">{partial}</span>
      )}
    </div>
  );
}
