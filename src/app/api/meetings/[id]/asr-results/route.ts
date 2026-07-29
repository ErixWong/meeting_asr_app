import { NextResponse } from "next/server";
import { CONTENT_MANAGER_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { listMeetingAsrResults } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    return NextResponse.json({ asrResults: listMeetingAsrResults(params.id) });
  });
}
