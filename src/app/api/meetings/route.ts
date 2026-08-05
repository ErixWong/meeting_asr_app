import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { createMeeting, createMeetingLlmResult, listMeetings } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
  return NextResponse.json({ meetings: listMeetings() });
  });
}

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
  try {
      const body = await req.json();
      const meeting = createMeeting({
        title: body.title,
        sourceType: body.sourceType,
        sourceFileName: body.sourceFileName ?? null,
        durationSeconds: body.durationSeconds ?? null,
        captureSessionId: body.captureSessionId ?? `capture-${Date.now()}`,
        transcriptSegments: body.transcriptSegments ?? [],
      });

      let defaultLlmResult: { triggered: boolean; status: string; error?: string } = {
        triggered: false,
        status: "skipped",
      };

      if (meeting?.id) {
        defaultLlmResult = { triggered: true, status: "pending" };
        void createMeetingLlmResult(meeting.id).catch((error) => {
          console.error("Failed to generate default LLM result:", error);
        });
      }

      return NextResponse.json({ meeting, defaultLlmResult });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create meeting" },
        { status: 400 }
      );
    }
  });
}
