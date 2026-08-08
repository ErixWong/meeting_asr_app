import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { translateSentences } from "@/lib/admin-store";
import { llmQueue } from "@/lib/llm-queue";

export const dynamic = "force-dynamic";

const ALLOWED_TARGET_LANGS = new Set(["zh", "en", "ja", "ko"]);
const MAX_SENTENCES = 50;
const MAX_TOTAL_CHARS = 4000;

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const sentences = Array.isArray(body.sentences)
        ? (body.sentences as unknown[]).filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : [];
      const targetLang = ALLOWED_TARGET_LANGS.has(String(body.targetLang)) ? String(body.targetLang) : "en";

      if (sentences.length === 0) {
        return NextResponse.json({ error: "No sentences to translate" }, { status: 400 });
      }
      if (sentences.length > MAX_SENTENCES || sentences.join("").length > MAX_TOTAL_CHARS) {
        return NextResponse.json({ error: "Translation payload too large" }, { status: 400 });
      }

      const result = await llmQueue.enqueue("translate", () => translateSentences(sentences, targetLang));
      return NextResponse.json({ text: result.text, elapsedMs: result.elapsedMs });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Translation failed" },
        { status: 500 }
      );
    }
  });
}
