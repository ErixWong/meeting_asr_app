export type RecordStatus =
  | "idle"
  | "connecting"
  | "recording"
  | "paused"
  | "generating"
  | "done";

export interface TranscriptSegment {
  id: string;
  speaker: string;
  speakerId?: number | null;
  text: string;
  time: string;
  timeSeconds: number;
  isFinal: boolean;
}

export interface MeetingRecord {
  id: string;
  title: string;
  date: string;
  durationLabel: string;
  transcript: TranscriptSegment[];
  summary: string;
}

export interface MeetingLlmResult {
  id: string;
  meetingAsrResultId: string;
  promptTemplateId: string;
  generationMode: string;
  status: string;
  versionNo: number;
  resultType: string;
  resultTitle: string;
  resultMarkdown: string;
  createdAt?: string;
}

export interface MeetingSendRecord {
  id: string;
  meetingLlmResultId: string;
  subject: string;
  status: string;
  providerType: string;
  providerMessageId?: string | null;
  errorMessage?: string | null;
  toRecipients: string[];
  ccRecipients: string[];
  createdAt?: string;
  sentAt?: string;
}

export interface Voiceprint {
  spkId: number;
  name: string;
  note: string;
}

export interface AudioDevice {
  deviceId: string;
  label: string;
}
