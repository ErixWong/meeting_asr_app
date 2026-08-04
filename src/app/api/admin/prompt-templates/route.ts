import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, CONTENT_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { createPromptTemplate, listPromptTemplates } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, CONTENT_ROLES, async () => {
  return NextResponse.json({ templates: listPromptTemplates() });
  });
}

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      const template = createPromptTemplate({
        templateKey: body.templateKey,
        templateName: body.templateName,
        templateType: body.templateType,
        content: body.content,
        description: body.description ?? "",
        status: body.status ?? "active",
      });
      return NextResponse.json({ template });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create prompt template" },
        { status: 400 }
      );
    }
  });
}
