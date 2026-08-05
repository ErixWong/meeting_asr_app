import { NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getRuntimeConfig } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
  return NextResponse.json(getRuntimeConfig());
  });
}
