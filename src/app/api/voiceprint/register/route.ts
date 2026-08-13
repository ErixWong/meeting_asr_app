import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { base64Float32ToInt16Pcm } from "@/lib/voiceprint-audio";
import { proxyVoiceprint, VoiceprintUnavailableError } from "@/lib/voiceprint-server";

export const dynamic = "force-dynamic";

const NAME_RE = /^[\w\-\u4e00-\u9fa5 ]{1,64}$/;

/**
 * POST /api/voiceprint/register
 * 注册/追加说话人样本（admin）。同名多次注册取均值 embedding。
 */
export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name ?? "").trim();
      if (!NAME_RE.test(name)) {
        return NextResponse.json(
          { error: "name must be 1-64 chars of letters/digits/_/-/space/Chinese" },
          { status: 400 }
        );
      }
      const { pcmBase64, sampleRate } = base64Float32ToInt16Pcm(
        String(body.audio ?? ""),
        Number(body.sampleRate)
      );

      const result = await proxyVoiceprint<{ ok: boolean; name: string; samples: number; elapsedMs: number }>(
        "/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, audio: pcmBase64, format: "pcm", sample_rate: sampleRate }),
        }
      );
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof VoiceprintUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "voiceprint register failed" },
        { status: 400 }
      );
    }
  });
}
