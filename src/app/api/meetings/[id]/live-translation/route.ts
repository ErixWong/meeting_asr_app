import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { persistLiveTranslation } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

const ALLOWED_TARGET_LANGS = new Set(["zh", "en", "ja", "ko"]);
const MAX_BLOCKS = 500;
const MAX_TOTAL_CHARS = 200_000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const targetLang = ALLOWED_TARGET_LANGS.has(String(body.targetLang)) ? String(body.targetLang) : "en";
      const blocks = Array.isArray(body.blocks)
        ? (body.blocks as unknown[])
            .filter(
              (item): item is { time?: unknown; timeSeconds?: unknown; text?: unknown } =>
                typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string" && Boolean((item as { text?: unknown }).text as string)
            )
            .map((item) => ({
              time: String((item as { time?: unknown }).time ?? ""),
              timeSeconds: Number((item as { timeSeconds?: unknown }).timeSeconds ?? 0),
              text: String((item as { text?: unknown }).text).trim(),
            }))
        : [];

      if (blocks.length === 0) {
        return NextResponse.json({ error: "No translation blocks to persist" }, { status: 400 });
      }
      if (blocks.length > MAX_BLOCKS || blocks.reduce((sum, block) => sum + block.text.length, 0) > MAX_TOTAL_CHARS) {
        return NextResponse.json({ error: "Translation payload too large" }, { status: 400 });
      }

      const saved = persistLiveTranslation(id, targetLang, blocks);
      if (!saved) {
        return NextResponse.json({ error: "Meeting not found or nothing to persist" }, { status: 404 });
      }
      return NextResponse.json({ saved: true, versionNo: saved.versionNo });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to persist live translation" },
        { status: 500 }
      );
    }
  });
}
