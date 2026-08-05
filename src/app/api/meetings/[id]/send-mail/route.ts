import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { createMeetingSendRecord } from "@/lib/admin-store";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json();
      const sendRecord = await createMeetingSendRecord({
        meetingId: id,
        meetingLlmResultId: body.meetingLlmResultId,
        subject: body.subject,
        toRecipients: body.toRecipients ?? [],
        ccRecipients: body.ccRecipients ?? [],
        mailTemplateType: body.mailTemplateType,
      });
      return NextResponse.json({ sendRecord });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send meeting result";
      const status = /required|not found|does not belong/i.test(message) ? 400 : 500;
      return NextResponse.json(
        { error: message },
        { status }
      );
    }
  });
}
