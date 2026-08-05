import type { TranscriptSegment } from "@/types";

export interface TranscriptResult {
  text: string;
  isFinal: boolean;
  speakerId?: number | null;
  time: string;
  timeSeconds: number;
}

export function updateTranscriptSegments(
  segments: TranscriptSegment[],
  result: TranscriptResult,
  createId: () => string
): TranscriptSegment[] {
  const lastIndex = segments.length - 1;
  const lastSegment = segments[lastIndex];

  if (lastSegment && !lastSegment.isFinal) {
    const updated = [...segments];
    updated[lastIndex] = result.isFinal
      ? {
          ...lastSegment,
          text: result.text,
          speakerId: result.speakerId,
          isFinal: true,
        }
      : {
          ...lastSegment,
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
