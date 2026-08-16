"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FunASRClient } from "@/lib/funasr";

interface Props {
  /** 语音识别结束后回调解码文本（可能为空）。 */
  onUtterance: (text: string) => void;
  disabled?: boolean;
}

const MAX_HOLD_MS = 60_000;
const START_TIMEOUT_MS = 8000;

type Phase = "idle" | "starting" | "holding";

/** 把底层错误翻译成用户能看懂的话 */
function friendlyError(err: Error): string {
  const m = err.message || String(err);
  if (/permission|NotAllowedError|denied|not allowed|\u6743\u9650/i.test(m))
    return "麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试";
  if (/NotReadable|\u88ab\u5360/i.test(m)) return "麦克风不可用或被占用，请检查设备";
  if (/timeout|\u8d85\u65f6/i.test(m)) return "语音服务启动超时，请检查网络或稍后再试";
  if (/connect|websocket|ECONN|socket/i.test(m)) return "语音识别服务连接失败，请稍后再试";
  return m;
}

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 按住说话：按下 → 浏览器采集 + ASR 网关实时转写（partial 实时回显）；
 * 松开 → 结束会话，取最终文本提交。松开后 600ms 内短暂可取消（未说话误触）。
 */
export default function ChatVoiceButton({ onUtterance, disabled = false }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const clientRef = useRef<FunASRClient | null>(null);
  const finalsRef = useRef<string[]>([]);
  const partialRef = useRef("");
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const releasingRef = useRef(false);
  // 启动竞态：startRecording 完成前用户已松手时标记，等连接就绪后立即结束
  const pendingReleaseRef = useRef(false);

  const stopTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const startTick = useCallback(() => {
    stopTick();
    setElapsed(0);
    tickRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }, [stopTick]);

  const cleanup = useCallback(() => {
    stopTick();
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    clientRef.current = null;
    setPhase("idle");
    setElapsed(0);
    setPartial("");
    partialRef.current = "";
  }, [stopTick]);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      stopTick();
      clientRef.current?.stopRecording().catch(() => {});
    };
  }, [stopTick]);

  const beginHold = useCallback(async () => {
    if (disabled || releasingRef.current || clientRef.current) return;
    releasingRef.current = true;
    pendingReleaseRef.current = false;
    finalsRef.current = [];
    partialRef.current = "";
    setPartial("");
    setError("");
    setPhase("starting");

    try {
      const client = new FunASRClient();
      clientRef.current = client;
      await Promise.race([
        client.startRecording({
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
            setError(friendlyError(err));
            cleanup();
          },
          lang: "auto",
        }),
        // 启动保护：getUserMedia / WebSocket 长时间无响应时不再让按钮卡在无反馈状态
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), START_TIMEOUT_MS)
        ),
      ]);
      setPhase("holding");
      startTick();
      // 超时保护：长按住自动结束
      holdTimerRef.current = setTimeout(() => {
        void finishHold();
      }, MAX_HOLD_MS);
      // 若启动期间用户已松开，立即结束（避免录音永不停止）
      if (pendingReleaseRef.current) {
        void finishHold();
      }
    } catch (err) {
      // 启动失败：显式停止并给出醒目错误（按钮不闪回无反馈状态）
      const client = clientRef.current;
      clientRef.current = null;
      if (client) client.stopRecording().catch(() => {});
      setError(friendlyError(err instanceof Error ? err : new Error(String(err))));
      setPhase("idle");
      setElapsed(0);
    } finally {
      releasingRef.current = false;
    }
  }, [cleanup, disabled, startTick]);

  const finishHold = useCallback(async () => {
    stopTick();
    const client = clientRef.current;
    clientRef.current = null;
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (!client) return;
    setPhase("idle");
    setElapsed(0);
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
  }, [onUtterance, stopTick]);

  const label =
    phase === "holding"
      ? `🎙 正在听… ${formatElapsed(elapsed)}`
      : phase === "starting"
        ? "🎙 正在启动…"
        : "🎙 按住说话";
  const btnCls =
    phase === "holding"
      ? "animate-pulse bg-red-600 text-white shadow-md"
      : phase === "starting"
        ? "bg-amber-500 text-white shadow-sm"
        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
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
        className={`select-none touch-none rounded-full px-5 py-2.5 text-sm font-medium shadow-sm transition disabled:opacity-40 ${btnCls}`}
        title="按住说话（松开后自动识别发送）"
        style={{ minWidth: "9rem" }}
      >
        {label}
      </button>
      {phase === "holding" && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 ring-1 ring-red-200">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
          录音中，松开即发送
        </span>
      )}
      {phase === "starting" && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          正在连接麦克风…
        </span>
      )}
      {partial && (
        <span className="max-w-[220px] truncate text-xs text-slate-500">{partial}</span>
      )}
      {error && (
        <span className="inline-flex items-start gap-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium leading-relaxed text-red-700 ring-1 ring-red-200">
          ⚠ {error}
        </span>
      )}
    </div>
  );
}
