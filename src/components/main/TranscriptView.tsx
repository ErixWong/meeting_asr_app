"use client";

import { useEffect, useRef, useMemo } from "react";
import { TranscriptSegment } from "@/types";

interface Props {
  segments: TranscriptSegment[];
  isHistory?: boolean;
  autoScroll?: boolean;
}

interface MergedParagraph {
  id: string;
  time: string;
  timeSeconds: number;
  speakerId: number | null;
  text: string;
  isFinal: boolean;
}

const SPEAKER_COLORS = [
  "text-blue-600",
  "text-emerald-600",
  "text-violet-600",
  "text-amber-600",
  "text-rose-600",
  "text-cyan-600",
  "text-pink-600",
  "text-indigo-600",
];

function getSpeakerLabel(speakerId: number | null): string {
  if (speakerId === null || speakerId === undefined) return "";
  const labels = "ABCDEFGH";
  return `说话人 ${labels[speakerId] || speakerId}`;
}

function mergeSegments(segments: TranscriptSegment[]): MergedParagraph[] {
  if (segments.length === 0) return [];

  const paragraphs: MergedParagraph[] = [];
  let current: MergedParagraph | null = null;

  for (const seg of segments) {
    const segSpeakerId = seg.speakerId ?? null;

    if (
      current &&
      current.speakerId === segSpeakerId &&
      current.isFinal
    ) {
      current.text += seg.text;
      current.isFinal = seg.isFinal;
    } else {
      if (current) {
        paragraphs.push(current);
      }
      current = {
        id: seg.id,
        time: seg.time,
        timeSeconds: seg.timeSeconds,
        speakerId: segSpeakerId,
        text: seg.text,
        isFinal: seg.isFinal,
      };
    }
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs;
}

export default function TranscriptView({ segments, isHistory, autoScroll = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const paragraphs = useMemo(() => mergeSegments(segments), [segments]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [paragraphs, autoScroll]);

  if (segments.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-slate-400">
        <div className="mb-4 text-6xl">🎙</div>
        <p className="text-lg">点击"开始录音"即可开始</p>
        <p className="mt-1 text-sm">系统将自动识别语音并转写为文字</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="scroll-thin h-full overflow-y-auto px-1 py-2">
      <div className="space-y-3">
        {paragraphs.map((para, idx) => (
          <div key={para.id} className="flex gap-3">
            <div className="w-14 shrink-0 pt-0.5 text-right text-xs text-slate-400">
              {para.time}
            </div>
            <div className="min-w-0 flex-1">
              {para.speakerId !== null && (
                <div className={`mb-0.5 text-xs font-medium ${SPEAKER_COLORS[para.speakerId % SPEAKER_COLORS.length]}`}>
                  {getSpeakerLabel(para.speakerId)}
                </div>
              )}
              <div className="text-[15px] leading-relaxed text-slate-700">
                {para.text}
                {!para.isFinal && (
                  <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-brand/60" />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
