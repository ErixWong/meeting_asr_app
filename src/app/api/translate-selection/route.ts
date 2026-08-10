import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { translateSelection } from "@/lib/admin-store";
import { llmQueue } from "@/lib/llm-queue";

export const dynamic = "force-dynamic";

const ALLOWED_TARGET_LANGS = new Set(["zh", "en", "ja", "ko"]);
const MAX_TEXT_CHARS = 600;

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const text = String(body.text ?? "").trim();
      const targetLang = ALLOWED_TARGET_LANGS.has(String(body.targetLang)) ? String(body.targetLang) : "en";

      if (!text) {
        return NextResponse.json({ error: "No text to translate" }, { status: 400 });
      }
      if (text.length > MAX_TEXT_CHARS) {
        return NextResponse.json({ error: "Selection too large" }, { status: 400 });
      }

      const result = await llmQueue.enqueue("translate", () => translateSelection(text, targetLang));
      return NextResponse.json({ text: result.text, elapsedMs: result.elapsedMs });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Translation failed" },
        { status: 500 }
      );
    }
  });
}
