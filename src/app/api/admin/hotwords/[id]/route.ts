import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { deleteHotword, updateHotword } from "@/lib/admin-store";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const body = await req.json();
      const hotword = updateHotword(params.id, {
        term: body.term,
        weight: body.weight === undefined ? undefined : Number(body.weight),
        status: body.status,
        note: body.note,
      });
      if (!hotword) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ hotword });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update hotword" },
        { status: 400 }
      );
    }
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const deleted = deleteHotword(params.id);
      if (!deleted) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to delete hotword" },
        { status: 400 }
      );
    }
  });
}
