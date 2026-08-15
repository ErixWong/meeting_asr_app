"use client";

import ChatPanel from "@/components/chat/ChatPanel";

export default function ChatPage() {
  return (
    <main className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm">
        <ChatPanel />
      </div>
    </main>
  );
}
