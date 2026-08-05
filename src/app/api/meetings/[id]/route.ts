import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  appendMeetingTranscript,
  createMeetingLlmResult,
  deleteMeeting,
  getMeetingById,
  getMeetingLightById,
  updateMeeting,
  updateTranscriptMeetingStatus,
} from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const view = new URL(req.url).searchParams.get("view");
    const meeting = view === "light" ? getMeetingLightById(id) : getMeetingById(id);
    if (!meeting) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ meeting });
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json();
      let meeting = getMeetingById(id);

      if (!meeting) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      if (Array.isArray(body.appendTranscriptSegments)) {
        meeting = appendMeetingTranscript({
          meetingId: id,
          captureSessionId: String(body.captureSessionId ?? `capture-${Date.now()}`),
          transcriptSegments: body.appendTranscriptSegments,
        });
      }

      if (body.title !== undefined) {
        meeting = updateMeeting(id, { title: body.title });
      }

      if (body.status !== undefined) {
        if (body.status !== "paused" && body.status !== "transcribed") {
          return NextResponse.json({ error: "Unsupported meeting status" }, { status: 400 });
        }
        if (body.status === "transcribed" && body.finalize !== true) {
          return NextResponse.json({ error: "Finalized meetings must set finalize=true" }, { status: 400 });
        }
        meeting = updateTranscriptMeetingStatus(id, body.status, body.lastErrorMessage ?? null);
      } else if (body.finalize === true) {
        return NextResponse.json({ error: "finalize requires status=transcribed" }, { status: 400 });
      }

      if (body.finalize === true) {
        void createMeetingLlmResult(id).catch((error) => {
          console.error("Failed to generate finalized meeting LLM result:", error);
        });
      }

      return NextResponse.json({ meeting });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update meeting" },
        { status: 400 }
      );
    }
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const deleted = deleteMeeting(id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  });
}
