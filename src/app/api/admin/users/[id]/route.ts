import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { updateUser } from "@/lib/admin-store";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const body = await req.json();
      const patch: Parameters<typeof updateUser>[1] = {
        accountName: body.accountName,
        displayName: body.displayName,
        email: body.email,
        department: body.department,
        status: body.status,
        roleKeys: Array.isArray(body.roleKeys) ? body.roleKeys : undefined,
      };
      if (typeof body.password === "string" && body.password !== "") {
        patch.password = body.password;
      }
      const user = updateUser(params.id, patch);

      if (!user) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      return NextResponse.json({ user });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update user" },
        { status: 400 }
      );
    }
  });
}
