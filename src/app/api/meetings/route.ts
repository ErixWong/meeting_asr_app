import { NextRequest, NextResponse } from "next/server";
import { createMeeting, listMeetings } from "@/lib/admin-store";

export async function GET() {
  return NextResponse.json({ meetings: listMeetings() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const meeting = createMeeting({
    title: body.title,
    sourceType: body.sourceType,
    sourceFileName: body.sourceFileName ?? null,
    durationSeconds: body.durationSeconds ?? null,
    captureSessionId: body.captureSessionId ?? `capture-${Date.now()}`,
    transcriptSegments: body.transcriptSegments ?? [],
  });

  return NextResponse.json({ meeting });
}
