import { NextResponse } from "next/server";
import { CONTENT_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getMeetingById, listMeetingSendRecords } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_ROLES, async () => {
    const meeting = getMeetingById(params.id);
    if (!meeting) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ sendRecords: listMeetingSendRecords(params.id) });
  });
}
