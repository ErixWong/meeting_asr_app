import { NextResponse } from "next/server";
import { CONTENT_MANAGER_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { updateHotword } from "@/lib/admin-store";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    try {
      const hotword = updateHotword(params.id, { status: "disabled" });
      if (!hotword) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ hotword });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to disable hotword" },
        { status: 400 }
      );
    }
  });
}
