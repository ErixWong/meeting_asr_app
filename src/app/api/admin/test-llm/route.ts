import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getSettingValue } from "@/lib/admin-store";
import { llmQueue } from "@/lib/llm-queue";

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      const baseUrl = String(body.baseUrl || "").replace(/\/$/, "");
      const apiKey = String(body.apiKey || getSettingValue("llm", "api_key"));
      const model = String(body.model || "");

      if (!baseUrl || !model) {
        return NextResponse.json({ ok: false, error: "LLM config incomplete" }, { status: 400 });
      }

      const disableThinking = getSettingValue("llm", "thinking_model") !== "0";

      await llmQueue.enqueue("test", async () => {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "你好，请回复 OK。" }],
            max_tokens: 256,
            temperature: 0,
            ...(disableThinking
              ? {
                  enable_thinking: false,
                  chat_template_kwargs: { enable_thinking: false },
                  think: false,
                }
              : {}),
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`LLM API error: ${response.status} ${errorText}`);
        }
      });

      return NextResponse.json({ ok: true });
    } catch (error) {
      const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
      const causeInfo =
        cause instanceof Error ? ` (${(cause as { code?: string }).code ?? cause.name}: ${cause.message})` : "";
      return NextResponse.json(
        { ok: false, error: `${error instanceof Error ? error.message : "LLM test failed"}${causeInfo}` },
        { status: 500 }
      );
    }
  });
}
