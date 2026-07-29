import { NextRequest, NextResponse } from "next/server";
import { CONTENT_MANAGER_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { createMeetingSendRecord } from "@/lib/admin-store";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
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
      const message = error instanceof Error ? error.message : "Failed to send meeting result";
      const status = /required|not found|does not belong/i.test(message) ? 400 : 500;
      return NextResponse.json(
        { error: message },
        { status }
      );
    }
  });
}
