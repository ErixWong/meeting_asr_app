import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { base64Float32ToInt16Pcm } from "@/lib/voiceprint-audio";
import { isVoiceprintEnabled, proxyVoiceprint, VoiceprintUnavailableError } from "@/lib/voiceprint-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/voiceprint/identify
 * 对一段句级音频做 1:N 说话人识别。任何登录用户可用（录音主流程调用）。
 * 声纹服务不可用 → 503（前端静默降级为聚类，不阻断录音）。
 */
export async function POST(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      if (!isVoiceprintEnabled()) {
        return NextResponse.json({ error: "voiceprint disabled" }, { status: 409 });
      }
      const body = await req.json().catch(() => ({}));
      const { pcmBase64, sampleRate } = base64Float32ToInt16Pcm(
        String(body.audio ?? ""),
        Number(body.sampleRate)
      );

      const result = await proxyVoiceprint<{
        matched: boolean;
        speaker: string | null;
        score: number;
        elapsedMs: number;
        top: Array<{ speaker: string; score: number }>;
      }>("/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: pcmBase64, format: "pcm", sample_rate: sampleRate }),
      });

      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof VoiceprintUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "voiceprint identify failed" },
        { status: 400 }
      );
    }
  });
}
