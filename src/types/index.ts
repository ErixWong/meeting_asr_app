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

export interface MeetingAudioRecording {
  id: string;
  captureSessionId: string;
  /** recording = 已录到 PCM、转码未完成；ready = mp3 可播放；failed = 转码失败 */
  status: "recording" | "ready" | "failed" | string;
  format: string;
  bytes: number;
  durationSeconds: number;
  bitrateKbps?: number | null;
  errorMessage?: string | null;
  createdAt?: string;
  downloadFileName: string;
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
  /**
   * feat-261101-01：是否有**可播放**的会议录音。
   * 口径（R2 统一）：存在 `audioRecordings` 里 `status === "ready"` 的条目即为 true；
   * 列表接口与详情接口走同一个投影函数（`admin-store.projectMeetingAudio`），不再各算一套。
   */
  hasAudio?: boolean;
  audioRecordings?: MeetingAudioRecording[];
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
  generationConfigSnapshot?: string | null;
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
