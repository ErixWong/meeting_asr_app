import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  claimMeetingLlmGeneration,
  createMeetingLlmResult,
  deleteMeetingLlmResult,
  listMeetingLlmResults,
  updateMeetingLlmResult,
} from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const llmResults = listMeetingLlmResults(id);
    if (llmResults === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ llmResults });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const claim = claimMeetingLlmGeneration(id);
      if (!claim.ok) {
        return NextResponse.json({ error: claim.error }, { status: claim.status });
      }

      void createMeetingLlmResult(id, body.promptTemplateId, { skipClaim: true, targetLang: body.targetLang }).catch((error) => {
        console.error("Failed to generate LLM result:", error);
      });

      return NextResponse.json({ started: true, status: "llm_processing" });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to generate llm result" },
        { status: 500 }
      );
    }
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const resultId = new URL(req.url).searchParams.get("resultId");
      if (!resultId) {
        return NextResponse.json({ error: "resultId query param required" }, { status: 400 });
      }
      const deleted = deleteMeetingLlmResult(id, resultId);
      if (!deleted) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to delete llm result" },
        { status: 500 }
      );
    }
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json();
      const llmResult = updateMeetingLlmResult(id, body.id, {
        resultMarkdown: body.resultMarkdown,
        resultTitle: body.resultTitle,
      });
      if (!llmResult) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ llmResult });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update llm result" },
        { status: 500 }
      );
    }
  });
}
