import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { setUserRoleKeys } from "@/lib/admin-store";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const body = await req.json();
      if (!Array.isArray(body.roleKeys)) {
        return NextResponse.json({ error: "roleKeys must be an array" }, { status: 400 });
      }

      const user = setUserRoleKeys(params.id, body.roleKeys);

      if (!user) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      return NextResponse.json({ user });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update user roles" },
        { status: 400 }
      );
    }
  });
}
