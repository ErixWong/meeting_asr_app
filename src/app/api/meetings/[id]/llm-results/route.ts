import { NextRequest, NextResponse } from "next/server";
import { CONTENT_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  createMeetingLlmResult,
  deleteMeetingLlmResult,
  getMeetingById,
  listMeetingLlmResults,
  updateMeetingLlmResult,
} from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_ROLES, async () => {
    const meeting = getMeetingById(params.id);
    if (!meeting) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ llmResults: listMeetingLlmResults(params.id) });
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_ROLES, async () => {
    try {
      const meeting = getMeetingById(params.id);
      if (!meeting) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const body = await req.json().catch(() => ({}));
      const llmResult = await createMeetingLlmResult(params.id, body.promptTemplateId);
      return NextResponse.json({ llmResult });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to generate llm result" },
        { status: 500 }
      );
    }
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_ROLES, async () => {
    try {
      const meeting = getMeetingById(params.id);
      if (!meeting) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const resultId = new URL(req.url).searchParams.get("resultId");
      if (!resultId) {
        return NextResponse.json({ error: "resultId query param required" }, { status: 400 });
      }
      const deleted = deleteMeetingLlmResult(params.id, resultId);
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

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_ROLES, async () => {
    try {
      const meeting = getMeetingById(params.id);
      if (!meeting) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const body = await req.json();
      const llmResult = updateMeetingLlmResult(params.id, body.id, {
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
