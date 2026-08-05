"use client";

import { useState } from "react";
import { MeetingAsrResultDetail } from "@/types";

type DetailTab = "normalized" | "config" | "session";

interface Props {
  result: MeetingAsrResultDetail;
}

const TABS: { key: DetailTab; label: string }[] = [
  { key: "normalized", label: "规范化文本" },
  { key: "config", label: "ASR 配置快照" },
  { key: "session", label: "会话信息（结构化）" },
];

export default function AsrResultDetailView({ result }: Props) {
  const [tab, setTab] = useState<DetailTab>("normalized");

  const asrConfigText = JSON.stringify(result.asrConfigSnapshot, null, 2);
  const rawAsrPayloadText = JSON.stringify(result.rawPayload, null, 2);

  return (
    <div className="min-w-0 space-y-4 text-sm">
      <div className="grid min-w-0 gap-3 md:grid-cols-3">
        <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs text-slate-400">Provider</div>
          <div className="mt-1 break-words font-medium text-slate-700">{result.asrProvider}</div>
        </div>
        <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs text-slate-400">Capture Session</div>
          <div className="mt-1 truncate font-mono text-xs text-slate-700">{result.captureSessionId}</div>
        </div>
        <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs text-slate-400">Format</div>
          <div className="mt-1 break-words font-medium text-slate-700">{result.resultFormat}</div>
        </div>
      </div>

      <div className="flex flex-col overflow-hidden rounded-lg border border-slate-200">
        <div className="flex gap-1 border-b border-slate-200 bg-slate-50 px-2 pt-2">
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={`rounded-t-md px-3 py-1.5 text-xs font-medium transition ${
                tab === item.key
                  ? "bg-white text-brand shadow-sm"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="scroll-thin min-w-0 max-h-[28rem] overflow-auto">
          {tab === "normalized" && (
            <pre className="whitespace-pre-wrap break-words p-3 text-xs leading-relaxed text-slate-700">
              {result.normalizedText || "-"}
            </pre>
          )}
          {tab === "config" && (
            <pre className="whitespace-pre-wrap break-words rounded-b-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
              {asrConfigText}
            </pre>
          )}
          {tab === "session" && (
            <pre className="whitespace-pre-wrap break-words rounded-b-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
              {rawAsrPayloadText}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
