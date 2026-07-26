"use client";

import { useState } from "react";
import { MeetingRecord } from "@/types";

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
        {meetings.map((m) => (
          <div
            key={m.id}
            onClick={() => onSelect(m)}
            className={`group mb-1 rounded-lg border-l-2 px-3 py-2 transition ${
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
                <div className="flex items-center justify-between">
                  <div className="truncate text-sm font-medium text-slate-700">
                    📄 {m.title}
                  </div>
                  <div
                    className="ml-1 hidden shrink-0 gap-1 group-hover:flex"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => startRename(m)}
                      className="rounded p-0.5 text-xs text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                      title="重命名"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`确定删除「${m.title}」？`)) {
                          onDelete(m.id);
                        }
                      }}
                      className="rounded p-0.5 text-xs text-slate-400 hover:bg-red-100 hover:text-red-600"
                      title="删除"
                    >
                      🗑
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {m.date} · {m.durationLabel}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
