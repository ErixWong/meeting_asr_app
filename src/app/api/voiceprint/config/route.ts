import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getSettingValue, saveSettings } from "@/lib/admin-store";
import {
  getVoiceprintEndpoint,
  isVoiceprintEnabled,
  proxyVoiceprint,
  VoiceprintUnavailableError,
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

/** GET /api/voiceprint/config — 声纹配置 + 服务连通性（登录用户） */
export async function GET(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const enabled = isVoiceprintEnabled();
    const endpoint = getVoiceprintEndpoint();
    let threshold: number | null = null;
    let serviceReachable = false;
    let serviceStatus: string | null = null;
    try {
      const health = await proxyVoiceprint<{ status: string; modelLoaded: boolean; speakers: number; threshold: number }>(
        "/health"
      );
      threshold = health.threshold;
      serviceReachable = true;
      serviceStatus = health.modelLoaded ? "ready" : "model-not-loaded";
    } catch (error) {
      serviceStatus = error instanceof Error ? error.message : "unreachable";
    }
    return NextResponse.json({
      enabled,
      endpoint: maskEndpoint(endpoint),
      threshold,
      serviceReachable,
      serviceStatus,
    });
  });
}

/**
 * PUT /api/voiceprint/config — 更新配置（admin）
 * body: { enabled?: boolean, endpoint?: string, threshold?: number }
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
      if (body.endpoint !== undefined) {
        const endpoint = String(body.endpoint ?? "").trim();
        try {
          const url = new URL(endpoint);
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad protocol");
        } catch {
          return NextResponse.json({ error: "endpoint must be a valid http(s) URL" }, { status: 400 });
        }
        changes.push({ itemSection: "voiceprint", itemMark: "endpoint", itemValue: endpoint });
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
          await proxyVoiceprint("/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threshold }),
          });
          messages.push("threshold updated");
        } catch (error) {
          if (error instanceof VoiceprintUnavailableError) {
            return NextResponse.json({ error: error.message }, { status: 503 });
          }
          throw error;
        }
      }

      return NextResponse.json({ ok: true, enabled: isVoiceprintEnabled(), messages });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "save voiceprint config failed" },
        { status: 400 }
      );
    }
  });
}
