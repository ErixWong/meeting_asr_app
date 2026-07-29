import { NextRequest, NextResponse } from "next/server";
import { CONTENT_MANAGER_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { deleteMeeting, getMeetingById, updateMeeting } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    const meeting = getMeetingById(params.id);
    if (!meeting) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ meeting });
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    try {
      const body = await req.json();
      const meeting = updateMeeting(params.id, {
        title: body.title,
      });

      if (!meeting) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      return NextResponse.json({ meeting });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update meeting" },
        { status: 400 }
      );
    }
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, CONTENT_MANAGER_ROLES, async () => {
    const deleted = deleteMeeting(params.id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  });
}
