import type { TranscriptSegment } from "@/types";

export interface TranscriptResult {
  text: string;
  isFinal: boolean;
  speakerId?: number | null;
  source?: "mic" | "speaker";
  deviceId?: string;
  time: string;
  timeSeconds: number;
}

function segmentSourceKey(segment: Pick<TranscriptSegment, "source" | "deviceId">): string {
  return `${segment.source ?? "mic"}:${segment.deviceId ?? ""}`;
}

export function updateTranscriptSegments(
  segments: TranscriptSegment[],
  result: TranscriptResult,
  createId: () => string
): TranscriptSegment[] {
  const resultKey = `${result.source ?? "mic"}:${result.deviceId ?? ""}`;

  let lastIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segmentSourceKey(segments[i]) === resultKey) {
      lastIndex = i;
      break;
    }
  }

  if (lastIndex >= 0 && !segments[lastIndex].isFinal) {
    const updated = [...segments];
    updated[lastIndex] = result.isFinal
      ? {
          ...updated[lastIndex],
          text: result.text,
          speakerId: result.speakerId,
          isFinal: true,
        }
      : {
          ...updated[lastIndex],
          text: result.text,
        };
    return updated;
  }

  return [
    ...segments,
    {
      id: createId(),
      speaker: "",
      speakerId: result.speakerId,
      source: result.source,
      deviceId: result.deviceId,
      text: result.text,
      time: result.time,
      timeSeconds: result.timeSeconds,
      isFinal: result.isFinal,
    },
  ];
}

export function finalizeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const lastIndex = segments.length - 1;
  const lastSegment = segments[lastIndex];

  if (!lastSegment || lastSegment.isFinal) return segments;

  const updated = [...segments];
  updated[lastIndex] = { ...lastSegment, isFinal: true };
  return updated;
}
