import { getSettingValue } from "@/lib/admin-store";

/**
 * 声纹服务代理（服务端模块，勿在客户端 import）
 * 声纹服务是独立容器（deploy/voiceprint），主应用经本模块转发请求。
 */

export const DEFAULT_VOICEPRINT_ENDPOINT = "http://127.0.0.1:10097";

/** 声纹模型/服务清单（admin 面板选择，各容器独立部署独立声纹库） */
export const VOICEPRINT_MODELS = {
  zh: { label: "中文版 CAM++（中文会议）", defaultEndpoint: "http://127.0.0.1:10097" },
  zh_en: { label: "中英双语版 CAM++（英文会议）", defaultEndpoint: "http://127.0.0.1:10098" },
} as const;

export type VoiceprintModelKey = keyof typeof VOICEPRINT_MODELS;

const PROXY_TIMEOUT_MS = 5000;

export function getVoiceprintModel(): VoiceprintModelKey {
  const raw = getSettingValue("voiceprint", "model");
  return raw === "zh_en" ? "zh_en" : "zh";
}

export function getVoiceprintEndpoint(): string {
  const model = getVoiceprintModel();
  const key = model === "zh_en" ? "endpoint_zh_en" : "endpoint_zh";
  // 兼容旧库：未配置 endpoint_zh 时回退旧的 voiceprint:endpoint（默认同为 10097）
  const value =
    getSettingValue("voiceprint", key) ||
    (model === "zh" ? getSettingValue("voiceprint", "endpoint") : "") ||
    VOICEPRINT_MODELS[model].defaultEndpoint;
  return value.replace(/\/+$/, "");
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
  timeoutMs: number = PROXY_TIMEOUT_MS,
  endpointOverride?: string
): Promise<T> {
  const endpoint = (endpointOverride ?? getVoiceprintEndpoint()).replace(/\/+$/, "");
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
    // 声纹服务 5xx（模型推理失败等）对调用方同样是“服务不可用”语义，统一映射为可降级错误
    if (res.status >= 500) {
      throw new VoiceprintUnavailableError(data?.error || `voiceprint service returned ${res.status}`);
    }
    throw new Error(data?.error || `voiceprint service returned ${res.status}`);
  }
  return data;
}
