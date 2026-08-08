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
  source?: "mic" | "speaker";
  deviceId?: string;
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
  status: string;
  lastErrorMessage?: string | null;
  transcript: TranscriptSegment[];
  summary: string;
}

export interface MeetingLlmResultSummary {
  id: string;
  meetingId: string;
  promptTemplateId: string;
  generationMode: string;
  status: string;
  versionNo: number;
  resultType: string;
  resultTitle: string;
  errorMessage?: string | null;
  createdAt?: string;
}

export interface MeetingLlmResultContent extends MeetingLlmResultSummary {
  resultMarkdown: string;
}

export interface MeetingLlmResult {
  id: string;
  meetingId: string;
  inputTranscriptSnapshot: string;
  promptTemplateId: string;
  generationMode: string;
  status: string;
  versionNo: number;
  resultType: string;
  resultTitle: string;
  resultMarkdown: string;
  errorMessage?: string | null;
  createdAt?: string;
}

export interface PromptTemplate {
  id: string;
  templateKey: string;
  templateName: string;
  templateType: string;
  content: string;
  description?: string;
  status: string;
  isSystem?: boolean;
  createdAt?: string;
  updatedAt?: string;
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

export interface MeetingAsrResult {
  id: string;
  meetingId: string;
  asrProvider: string;
  asrSettingMark: string;
  captureSessionId: string;
  resultFormat: string;
  rawPayloadBytes?: number;
  normalizedTextLength?: number;
  createdAt?: string;
}

export interface MeetingAsrResultDetail extends MeetingAsrResult {
  asrConfigSnapshot: unknown;
  rawPayload: unknown;
  normalizedText: string;
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
