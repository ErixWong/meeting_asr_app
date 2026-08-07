"use client";

import { useLayoutEffect, useRef, useMemo } from "react";
import { TranscriptSegment } from "@/types";

interface Props {
  segments: TranscriptSegment[];
  autoScroll?: boolean;
}

interface MergedParagraph {
  id: string;
  time: string;
  timeSeconds: number;
  speakerId: number | null;
  source: "mic" | "speaker" | undefined;
  deviceId?: string;
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
const AUTO_SCROLL_THRESHOLD_PX = 48;

function stripSenseVoiceTokens(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, "").trim();
}

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
    const segSource = seg.source ?? undefined;

    if (
      current &&
      segSource === current.source &&
      seg.deviceId === current.deviceId &&
      segSpeakerId !== null &&
      current.speakerId === segSpeakerId &&
      current.isFinal
    ) {
      current.text += stripSenseVoiceTokens(seg.text);
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
        source: segSource,
        deviceId: seg.deviceId,
        text: stripSenseVoiceTokens(seg.text),
        isFinal: seg.isFinal,
      };
    }
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs;
}

export default function TranscriptView({ segments, autoScroll = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  const paragraphs = useMemo(() => mergeSegments(segments), [segments]);

  useLayoutEffect(() => {
    if (segments.length === 0) {
      shouldAutoScrollRef.current = true;
      return;
    }
    if (!autoScroll || !shouldAutoScrollRef.current || !containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [autoScroll, paragraphs, segments.length]);

  if (segments.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-slate-400">
        <div className="mb-4 text-6xl">🎙</div>
        <p className="text-lg">点击 &quot;开始录音&quot; 即可开始</p>
        <p className="mt-1 text-sm">系统将自动识别语音并转写为文字</p>
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
        {paragraphs.map((para) => (
          <div key={para.id} className="flex gap-3">
            <div className="w-14 shrink-0 pt-0.5 text-right text-xs text-slate-400">
              {para.time}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex flex-wrap items-center gap-2 text-xs">
                {para.source !== undefined && (
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ${
                    para.source === "speaker"
                      ? "bg-violet-50 text-violet-600"
                      : "bg-sky-50 text-sky-600"
                  }`}>
                    {para.source === "speaker" ? "🔊 系统声音" : "🎤 麦克风"}
                  </span>
                )}
                {para.speakerId !== null && (
                  <span className={`font-medium ${SPEAKER_COLORS[para.speakerId % SPEAKER_COLORS.length]}`}>
                    {getSpeakerLabel(para.speakerId)}
                  </span>
                )}
                {para.deviceId && (
                  <span className="text-slate-400" title={para.deviceId}>
                    {para.deviceId.length > 16 ? `${para.deviceId.slice(0, 16)}…` : para.deviceId}
                  </span>
                )}
              </div>
              <div className="text-[15px] leading-relaxed text-slate-700">
                {para.text}
                {!para.isFinal && (
                  <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-brand/50" />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
