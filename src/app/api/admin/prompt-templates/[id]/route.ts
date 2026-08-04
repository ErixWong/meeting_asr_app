import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { updatePromptTemplate } from "@/lib/admin-store";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const body = await req.json();
      const template = updatePromptTemplate(params.id, body);
      if (!template) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ template });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update prompt template" },
        { status: 400 }
      );
    }
  });
}
