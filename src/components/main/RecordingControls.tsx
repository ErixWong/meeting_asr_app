"use client";

import { RecordStatus } from "@/types";

interface Props {
  status: RecordStatus;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  muted?: boolean;
  micEnabled?: boolean;
  onToggleMute?: () => void;
}

function formatTime(sec: number) {
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function RecordingControls({
  status,
  onStart,
  onPause,
  onResume,
  onStop,
  muted = false,
  micEnabled = false,
  onToggleMute,
}: Props) {
  const recording = status === "recording";
  const paused = status === "paused";

  return (
    <div className="flex items-center gap-3">
      {(recording || paused) && (
        <div className="flex items-center gap-2 text-sm">
          <span className={paused ? "h-3 w-3 rounded-full bg-amber-400" : "rec-dot"} />
          <span className={paused ? "text-amber-600" : "text-red-600"}>
            {paused ? "已暂停" : "录音中"}
          </span>
        </div>
      )}

      {status === "idle" || status === "done" ? (
        <button
          onClick={onStart}
          className="flex items-center gap-2 rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-dark"
        >
          <span className="text-base leading-none">●</span> 开始录音
        </button>
      ) : recording ? (
        <>
          {micEnabled && (
            <button
              onClick={onToggleMute}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              {muted ? "🔇 已静音" : "🎙 静音"}
            </button>
          )}
          <button
            onClick={onPause}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            ⏸ 暂停
          </button>
          <button
            onClick={onStop}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-red-700"
          >
            ■ 结束录音
          </button>
        </>
      ) : paused ? (
        <>
          <button
            onClick={onResume}
            className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-dark"
          >
            ▶ 继续录音
          </button>
          <button
            onClick={onStop}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-red-700"
          >
            ■ 结束录音
          </button>
        </>
      ) : (
        <button
          disabled
          className="flex items-center gap-2 rounded-lg bg-slate-300 px-5 py-2 text-sm font-medium text-white shadow-sm"
        >
          {status === "connecting" ? "连接中..." : "生成纪要中..."}
        </button>
      )}
    </div>
  );
}

export { formatTime };
