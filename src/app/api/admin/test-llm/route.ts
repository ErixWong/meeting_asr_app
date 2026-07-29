import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      const baseUrl = String(body.baseUrl || "").replace(/\/$/, "");
      const apiKey = String(body.apiKey || "");
      const model = String(body.model || "");

      if (!baseUrl || !model) {
        return NextResponse.json({ ok: false, error: "LLM config incomplete" }, { status: 400 });
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "你好，请回复 OK。" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return NextResponse.json(
          { ok: false, error: `LLM API error: ${response.status} ${errorText}` },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "LLM test failed" },
        { status: 500 }
      );
    }
  });
}
