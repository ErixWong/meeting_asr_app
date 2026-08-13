import { getSettingValue } from "@/lib/admin-store";

/**
 * 声纹服务代理（服务端模块，勿在客户端 import）
 * 声纹服务是独立容器（deploy/voiceprint），主应用经本模块转发请求。
 */

export const DEFAULT_VOICEPRINT_ENDPOINT = "http://127.0.0.1:10097";
const PROXY_TIMEOUT_MS = 5000;

export function getVoiceprintEndpoint(): string {
  return getSettingValue("voiceprint", "endpoint") || DEFAULT_VOICEPRINT_ENDPOINT;
}

export function isVoiceprintEnabled(): boolean {
  return getSettingValue("voiceprint", "enabled") !== "false";
}

/** 转发到声纹服务；服务不可用/超时抛 VoiceprintUnavailableError（调用方做降级） */
export class VoiceprintUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceprintUnavailableError";
  }
}

export async function proxyVoiceprint<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = PROXY_TIMEOUT_MS
): Promise<T> {
  const endpoint = getVoiceprintEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${endpoint}${path}`, { ...init, signal: controller.signal });
  } catch (error) {
    throw new VoiceprintUnavailableError(
      error instanceof Error ? `voiceprint service unreachable: ${error.message}` : "voiceprint service unreachable"
    );
  } finally {
    clearTimeout(timer);
  }

  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data?.error || `voiceprint service returned ${res.status}`);
  }
  return data;
}
