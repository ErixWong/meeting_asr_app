import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  createMeetingLlmResult,
  deleteMeetingLlmResult,
  listMeetingLlmResults,
  updateMeetingLlmResult,
} from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    return NextResponse.json({ llmResults: listMeetingLlmResults(id) });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const llmResult = await createMeetingLlmResult(id, body.promptTemplateId);
      return NextResponse.json({ llmResult });
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
