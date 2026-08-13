import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { proxyVoiceprint, VoiceprintUnavailableError } from "@/lib/voiceprint-server";

export const dynamic = "force-dynamic";

/** GET /api/voiceprint/speakers — 说话人列表（admin） */
export async function GET(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const result = await proxyVoiceprint<{
        speakers: Array<{ name: string; samples: number; createdAt: string; updatedAt: string }>;
      }>("/speakers");
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof VoiceprintUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "list speakers failed" },
        { status: 500 }
      );
    }
  });
}

/** DELETE /api/voiceprint/speakers?name=xxx — 删除说话人（admin） */
export async function DELETE(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const name = req.nextUrl.searchParams.get("name")?.trim();
      if (!name) {
        return NextResponse.json({ error: "name query param is required" }, { status: 400 });
      }
      const result = await proxyVoiceprint<{ ok: boolean; name: string }>(`/speakers/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof VoiceprintUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "delete speaker failed" },
        { status: 400 }
      );
    }
  });
}
