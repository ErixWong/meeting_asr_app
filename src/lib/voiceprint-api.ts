/**
 * 声纹服务客户端封装（浏览器端）
 * 经 Next.js API 代理（/api/voiceprint/*）访问独立声纹容器，服务不可用时抛
 * VoiceprintApiError，调用方（page.tsx）静默降级到前端启发式聚类。
 */

export interface VoiceprintIdentifyResult {
  matched: boolean;
  speaker: string | null;
  score: number;
  elapsedMs: number;
  top: Array<{ speaker: string; score: number }>;
}

export interface VoiceprintSpeaker {
  name: string;
  samples: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceprintServiceStatus {
  reachable: boolean;
  status: string | null;
  threshold: number | null;
  speakers: number | null;
  endpoint: string;
}

export interface VoiceprintConfig {
  enabled: boolean;
  model: "zh" | "zh_en";
  models: {
    zh: VoiceprintServiceStatus;
    zh_en: VoiceprintServiceStatus;
  };
  // 兼容字段（当前模型）
  endpoint: string;
  threshold: number | null;
  serviceReachable: boolean;
  serviceStatus: string | null;
}

export class VoiceprintApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceprintApiError";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new VoiceprintApiError(data?.error || `voiceprint api ${res.status}`);
  }
  return data;
}

function float32ToBase64(audio: Float32Array): string {
  const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 句级说话人识别（音频须为 16k 单声道 Float32Array） */
export function identifyVoiceprint(audio: Float32Array, sampleRate = 16000): Promise<VoiceprintIdentifyResult> {
  return api<VoiceprintIdentifyResult>("/api/voiceprint/identify", {
    method: "POST",
    body: JSON.stringify({ audio: float32ToBase64(audio), sampleRate }),
  });
}

export function getVoiceprintConfig(): Promise<VoiceprintConfig> {
  return api<VoiceprintConfig>("/api/voiceprint/config");
}

export function getVoiceprintSpeakers(): Promise<{ speakers: VoiceprintSpeaker[] }> {
  return api<{ speakers: VoiceprintSpeaker[] }>("/api/voiceprint/speakers");
}

export function registerVoiceprintSpeaker(
  name: string,
  audio: Float32Array,
  sampleRate = 16000
): Promise<{ ok: boolean; name: string; samples: number; elapsedMs: number }> {
  return api<{ ok: boolean; name: string; samples: number; elapsedMs: number }>("/api/voiceprint/register", {
    method: "POST",
    body: JSON.stringify({ name, audio: float32ToBase64(audio), sampleRate }),
  });
}

export function deleteVoiceprintSpeaker(name: string): Promise<{ ok: boolean; name: string }> {
  return api<{ ok: boolean; name: string }>(`/api/voiceprint/speakers?name=${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function saveVoiceprintConfig(patch: {
  enabled?: boolean;
  model?: "zh" | "zh_en";
  endpoint_zh?: string;
  endpoint_zh_en?: string;
  threshold?: number;
}) {
  return api<{ ok: boolean; enabled: boolean; model: "zh" | "zh_en"; messages: string[] }>("/api/voiceprint/config", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}
