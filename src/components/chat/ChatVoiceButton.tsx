"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FunASRClient } from "@/lib/funasr";
import { friendlyError } from "@/lib/chat-voice-errors";

interface Props {
  /** 语音识别结束后回调解码文本（可能为空）。 */
  onUtterance: (text: string) => void;
  disabled?: boolean;
}

const MAX_HOLD_MS = 60_000;
const START_TIMEOUT_MS = 8000;

type Phase = "idle" | "starting" | "holding";

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
  // 启动竞态靠 clientRef 判定：beginHold 在第一个 await 之前就同步写好 clientRef.current，
  // 而 finishHold 会把 clientRef.current 置空并接管收尾 —— 所以「await 期间松手」用
  // `clientRef.current !== client` 就能识别。原先的 pendingReleaseRef 守卫的是 pointerup 里
  // `!clientRef.current` 这条分支，而该分支因上述同步赋值**永不可达**，已删除。
  // finishHold 存 ref：beginHold 里要用它收尾，但直接引变量会进依赖数组（与 cleanup/startTick 互指成环），
  // 存 ref 后 beginHold 只依赖稳定引用，stale closure 也拿到最新实现
  const finishHoldRef = useRef<(() => Promise<void>) | null>(null);

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
    finalsRef.current = [];
    partialRef.current = "";
    setPartial("");
    setError("");
    setPhase("starting");

    let client: FunASRClient | null = null;
    try {
      client = new FunASRClient();
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
            // friendlyError 返回空串表示安静处理（如 AbortError），setError("") 不渲染徽标
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
      // 启动期间用户已松手（finishHold 已置空 clientRef、清 phase、停 tick、调过 stopRecording）：
      // 这里绝不能再把 phase 复活成 holding，也不能重复 stopRecording（否则会二次 session.finish）
      if (clientRef.current !== client) return;
      setPhase("holding");
      startTick();
      // 超时保护：长按住自动结束
      holdTimerRef.current = setTimeout(() => {
        void finishHoldRef.current?.();
      }, MAX_HOLD_MS);
    } catch (err) {
      // 已被 finishHold 收尾（启动期间松手 / 60s 兜底）：那次启动由它负责停掉，这里安静退出
      if (clientRef.current !== client) return;
      // 启动失败：显式停止并给出醒目错误（按钮不闪回无反馈状态）
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
    // 幂等清态：即使 client 已被清过（启动期间松手 / 60s 兜底晚到），也必须回到 idle 并停表。
    // 否则界面会永久停在「正在听…」而实际什么都没录（真机回归 261101-01 F1）。
    stopTick();
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    const client = clientRef.current;
    clientRef.current = null;
    setPhase("idle");
    setElapsed(0);
    if (!client) return;
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

  // 每次渲染后把最新的 finishHold 写进 ref（beginHold / 定时器通过 ref 调用，避开依赖循环）
  useEffect(() => {
    finishHoldRef.current = finishHold;
  }, [finishHold]);

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
          // beginHold 在第一个 await 之前就同步写了 clientRef.current，所以启动中松手这里也看得到它：
          // 直接由 finishHold 接管（清 clientRef → beginHold 在 await 之后自检退出，不再复活 holding）
          if (!clientRef.current) return;
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
