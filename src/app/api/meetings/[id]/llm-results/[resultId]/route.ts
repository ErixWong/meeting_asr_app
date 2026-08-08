import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getMeetingLlmResultDetail } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; resultId: string }> }) {
  const { id, resultId } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const llmResult = getMeetingLlmResultDetail(id, resultId);
    if (!llmResult) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ llmResult });
  });
}
