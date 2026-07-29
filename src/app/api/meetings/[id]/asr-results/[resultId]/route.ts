import { NextResponse } from "next/server";
import { CONTENT_MANAGER_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getMeetingAsrResultDetail } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: { id: string; resultId: string } }
) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    const asrResult = getMeetingAsrResultDetail(params.id, params.resultId);
    if (!asrResult) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ asrResult });
  });
}
