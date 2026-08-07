import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { llmQueue } from "@/lib/llm-queue";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, () => {
    return NextResponse.json(llmQueue.getStatus());
  });
}
