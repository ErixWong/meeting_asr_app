"use client";

import { useState } from "react";
import { MeetingRecord } from "@/types";
import { getMeetingStatusMeta } from "@/lib/meeting-status";

interface Props {
  meetings: MeetingRecord[];
  selectedId: string | null;
  onSelect: (m: MeetingRecord) => void;
  onCreateNew: () => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
}

export default function HistoryList({ meetings, selectedId, onSelect, onCreateNew, onRename, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startRename = (m: MeetingRecord) => {
    setEditingId(m.id);
    setEditValue(m.title);
  };

  const confirmRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2">
        <input
          placeholder="🔍 搜索会议..."
          className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={onCreateNew}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand text-white transition hover:bg-brand-dark"
          title="新建会议"
        >
          +
        </button>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-2">
        <div className="px-1 pb-1 pt-2 text-xs font-medium text-slate-400">
          今天
        </div>
        {meetings.map((m) => {
          const statusMeta = getMeetingStatusMeta(m.status);

          return (
            <div
              key={m.id}
              onClick={() => onSelect(m)}
              className={`group mb-1 cursor-pointer select-none rounded-lg border-l-2 px-3 py-2 transition ${
                selectedId === m.id
                  ? "border-brand bg-brand/5"
                  : "border-transparent hover:bg-slate-100"
              }`}
            >
            {editingId === m.id ? (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={confirmRename}
                  className="min-w-0 flex-1 rounded border border-brand bg-white px-1.5 py-0.5 text-sm outline-none"
                />
              </div>
            ) : (
              <>
                 <div className="flex items-center justify-between gap-2">
                   <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
                     📄 {m.title}
                   </div>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${statusMeta.className}`}>
                    {statusMeta.label}
                  </span>
                  <div
                    className="ml-1 hidden shrink-0 gap-1 group-hover:flex"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => startRename(m)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                      title="重命名"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
                        <path d="M11.78 1.72a1.5 1.5 0 0 1 2.12 2.12l-7.6 7.6-2.83.71.71-2.83 7.6-7.6Z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`确定删除「${m.title}」？`)) {
                          onDelete(m.id);
                        }
                      }}
                      className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
                      title="删除"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
                        <path d="M6.5 1.5A.5.5 0 0 1 7 1h2a.5.5 0 0 1 .5.5V2h3a.5.5 0 0 1 0 1h-.3l-.7 10.05A1.5 1.5 0 0 1 10.01 14.5H5.99a1.5 1.5 0 0 1-1.49-1.45L3.8 3H3.5a.5.5 0 0 1 0-1h3V1.5ZM5 3l.7 10.02a.5.5 0 0 0 .5.48h3.6a.5.5 0 0 0 .5-.48L11 3H5Zm1.5 1.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5Z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {m.date} · {m.durationLabel}
                </div>
              </>
            )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
