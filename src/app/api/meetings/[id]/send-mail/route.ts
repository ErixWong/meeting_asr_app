import { NextRequest, NextResponse } from "next/server";
import { createMeetingSendRecord } from "@/lib/admin-store";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const sendRecord = await createMeetingSendRecord({
      meetingId: params.id,
      meetingLlmResultId: body.meetingLlmResultId,
      subject: body.subject,
      toRecipients: body.toRecipients ?? [],
      ccRecipients: body.ccRecipients ?? [],
      mailTemplateType: body.mailTemplateType,
    });
    return NextResponse.json({ sendRecord });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send meeting result" },
      { status: 500 }
    );
  }
}
