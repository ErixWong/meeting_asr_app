import { NextRequest, NextResponse } from "next/server";
import { CONTENT_MANAGER_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { createMeetingLlmResult, listMeetingLlmResults, updateMeetingLlmResult } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    return NextResponse.json({ llmResults: listMeetingLlmResults(params.id) });
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    try {
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

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    try {
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
