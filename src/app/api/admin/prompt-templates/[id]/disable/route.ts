import { NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { updatePromptTemplate } from "@/lib/admin-store";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
    try {
      const template = updatePromptTemplate(params.id, { status: "disabled" });
      if (!template) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ template });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to disable prompt template" },
        { status: 400 }
      );
    }
  });
}
