import { NextRequest, NextResponse } from "next/server";
import { createPromptTemplate, listPromptTemplates } from "@/lib/admin-store";

export async function GET() {
  return NextResponse.json({ templates: listPromptTemplates() });
}

export async function POST(req: NextRequest) {
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
}
