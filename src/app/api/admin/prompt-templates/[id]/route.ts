import { NextRequest, NextResponse } from "next/server";
import { updatePromptTemplate } from "@/lib/admin-store";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const template = updatePromptTemplate(params.id, body);
  return NextResponse.json({ template });
}
