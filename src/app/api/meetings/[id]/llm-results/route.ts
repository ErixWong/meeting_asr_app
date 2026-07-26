import { NextRequest, NextResponse } from "next/server";
import { createMeetingLlmResult, listMeetingLlmResults, updateMeetingLlmResult } from "@/lib/admin-store";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  return NextResponse.json({ llmResults: listMeetingLlmResults(params.id) });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const llmResult = updateMeetingLlmResult(body.id, {
      resultMarkdown: body.resultMarkdown,
      resultTitle: body.resultTitle,
    });
    return NextResponse.json({ llmResult });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update llm result" },
      { status: 500 }
    );
  }
}
