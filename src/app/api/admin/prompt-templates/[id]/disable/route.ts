import { NextResponse } from "next/server";
import { updatePromptTemplate } from "@/lib/admin-store";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  const template = updatePromptTemplate(params.id, { status: "disabled" });
  return NextResponse.json({ template });
}
