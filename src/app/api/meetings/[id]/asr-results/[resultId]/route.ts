import { NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getMeetingAsrResultDetail } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; resultId: string }> }
) {
  const { id, resultId } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const asrResult = getMeetingAsrResultDetail(id, resultId);
    if (!asrResult) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ asrResult });
  });
}
