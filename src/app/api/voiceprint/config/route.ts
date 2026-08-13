import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getSettingValue, saveSettings } from "@/lib/admin-store";
import {
  getVoiceprintEndpoint,
  getVoiceprintModel,
  isVoiceprintEnabled,
  proxyVoiceprint,
  VOICEPRINT_MODELS,
} from "@/lib/voiceprint-server";

export const dynamic = "force-dynamic";

function maskEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" ? endpoint : `${url.protocol}//***:${url.port}`;
  } catch {
    return endpoint;
  }
}

const ENDPOINT_KEYS = {
  zh: "endpoint_zh",
  zh_en: "endpoint_zh_en",
} as const;

async function probeService(model: keyof typeof VOICEPRINT_MODELS): Promise<{
  reachable: boolean;
  status: string | null;
  threshold: number | null;
  speakers: number | null;
}> {
  const endpoint = (getSettingValue("voiceprint", ENDPOINT_KEYS[model]) || VOICEPRINT_MODELS[model].defaultEndpoint).replace(/\/+$/, "");
  try {
    const health = await proxyVoiceprint<{ modelLoaded: boolean; speakers: number; threshold: number }>(
      "/health",
      undefined,
      undefined,
      endpoint
    );
    return {
      reachable: true,
      status: health.modelLoaded ? "ready" : "model-not-loaded",
      threshold: health.threshold,
      speakers: health.speakers,
    };
  } catch (error) {
    return {
      reachable: false,
      status: error instanceof Error ? error.message : "unreachable",
      threshold: null,
      speakers: null,
    };
  }
}

/** GET /api/voiceprint/config — 声纹配置 + 双服务连通性（登录用户） */
export async function GET(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const enabled = isVoiceprintEnabled();
    const model = getVoiceprintModel();
    const [zh, zhEn] = await Promise.all([probeService("zh"), probeService("zh_en")]);
    return NextResponse.json({
      enabled,
      model,
      models: {
        zh: { ...zh, endpoint: maskEndpoint(getSettingValue("voiceprint", "endpoint_zh") || VOICEPRINT_MODELS.zh.defaultEndpoint) },
        zh_en: { ...zhEn, endpoint: maskEndpoint(getSettingValue("voiceprint", "endpoint_zh_en") || VOICEPRINT_MODELS.zh_en.defaultEndpoint) },
      },
      // 兼容旧客户端字段
      endpoint: maskEndpoint(getVoiceprintEndpoint()),
      threshold: model === "zh_en" ? zhEn.threshold : zh.threshold,
      serviceReachable: model === "zh_en" ? zhEn.reachable : zh.reachable,
      serviceStatus: model === "zh_en" ? zhEn.status : zh.status,
    });
  });
}

/**
 * PUT /api/voiceprint/config — 更新配置（admin）
 * body: { enabled?: boolean, model?: "zh"|"zh_en", endpoint_zh?: string, endpoint_zh_en?: string, threshold?: number }
 * threshold 作用于当前模型服务；切换模型后需在对应声纹库注册说话人（两库独立）。
 */
export async function PUT(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const changes: Array<{ itemSection: string; itemMark: string; itemValue: string }> = [];
      const messages: string[] = [];

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
        }
        changes.push({ itemSection: "voiceprint", itemMark: "enabled", itemValue: String(body.enabled) });
      }
      if (body.model !== undefined) {
        if (!["zh", "zh_en"].includes(String(body.model))) {
          return NextResponse.json({ error: "model must be zh or zh_en" }, { status: 400 });
        }
        changes.push({ itemSection: "voiceprint", itemMark: "model", itemValue: String(body.model) });
      }
      for (const key of ["endpoint_zh", "endpoint_zh_en"] as const) {
        if (body[key] !== undefined) {
          const endpoint = String(body[key] ?? "").trim();
          try {
            const url = new URL(endpoint);
            if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad protocol");
          } catch {
            return NextResponse.json({ error: `${key} must be a valid http(s) URL` }, { status: 400 });
          }
          changes.push({ itemSection: "voiceprint", itemMark: key, itemValue: endpoint });
        }
      }
      if (changes.length > 0) {
        saveSettings(changes);
      }

      if (body.threshold !== undefined) {
        const threshold = Number(body.threshold);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          return NextResponse.json({ error: "threshold must be between 0 and 1" }, { status: 400 });
        }
        try {
          // 阈值存于声纹服务自身（meta 表），作用于当前模型的服务
          await proxyVoiceprint("/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threshold }),
          });
          messages.push("threshold updated");
        } catch (error) {
          // 设置已保存成功，阈值同步失败不能回滚——如实告知（部分成功）
          messages.push(`threshold not updated: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }

      return NextResponse.json({ ok: true, enabled: isVoiceprintEnabled(), model: getVoiceprintModel(), messages });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "save voiceprint config failed" },
        { status: 400 }
      );
    }
  });
}
