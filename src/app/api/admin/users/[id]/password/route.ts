import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { resetUserPassword } from "@/lib/admin-store";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const user = resetUserPassword(id, body.nextPassword);
      if (!user) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      return NextResponse.json({ user, mustChangePassword: true });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to reset password" },
        { status: 400 }
      );
    }
  });
}