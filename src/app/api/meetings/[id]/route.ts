import { NextResponse } from "next/server";
import { getMeetingById } from "@/lib/admin-store";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const meeting = getMeetingById(params.id);
  if (!meeting) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ meeting });
}
