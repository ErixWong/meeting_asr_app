import { NextResponse } from "next/server";
import { updateHotword } from "@/lib/admin-store";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  const hotword = updateHotword(params.id, { status: "disabled" });
  return NextResponse.json({ hotword });
}
