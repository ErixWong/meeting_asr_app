import { NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { listAuditLogs } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  return NextResponse.json({ auditLogs: listAuditLogs(100) });
  });
}
