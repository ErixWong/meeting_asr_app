"use client";

import { useLayoutEffect, useRef } from "react";

export interface TranslationBlock {
  id: number;
  text: string;
  time: string;
  timeSeconds: number;
}

interface Props {
  translations: TranslationBlock[];
}

const AUTO_SCROLL_THRESHOLD_PX = 48;

export default function TranslationView({ translations }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  useLayoutEffect(() => {
    if (translations.length === 0) {
      shouldAutoScrollRef.current = true;
      return;
    }
    if (!shouldAutoScrollRef.current || !containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [translations]);

  const isEmpty = translations.length === 0;

  if (isEmpty) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-slate-400">
        <div className="text-2xl">🌐</div>
        <p className="mt-2 text-sm">等待翻译...</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={(event) => {
        const target = event.currentTarget;
        const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
        shouldAutoScrollRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
      }}
      className="scroll-thin h-full overflow-y-auto px-1 py-2"
    >
      <div className="space-y-3">
        {translations.map((block) => (
          <div key={block.id} className="flex gap-3">
            <div className="w-14 shrink-0 pt-0.5 text-right text-xs text-slate-400">{block.time}</div>
            <div className="min-w-0 flex-1 text-[15px] leading-relaxed text-emerald-700">
              {block.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
