import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { createUser, listUsers } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  return NextResponse.json({ users: listUsers() });
  });
}

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      if (body.roleKeys !== undefined && !Array.isArray(body.roleKeys)) {
        return NextResponse.json({ error: "roleKeys must be an array" }, { status: 400 });
      }

      const user = createUser({
        accountName: body.accountName,
        displayName: body.displayName,
        email: body.email ?? "",
        department: body.department ?? "",
        status: body.status ?? "active",
        roleKeys: body.roleKeys,
      });

      return NextResponse.json({ user });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create user" },
        { status: 400 }
      );
    }
  });
}
