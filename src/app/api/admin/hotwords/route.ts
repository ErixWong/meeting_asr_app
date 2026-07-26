import { NextRequest, NextResponse } from "next/server";
import { createHotword, listHotwords } from "@/lib/admin-store";

export async function GET() {
  return NextResponse.json({ hotwords: listHotwords() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const hotword = createHotword({
    term: body.term,
    weight: Number(body.weight ?? 10),
    status: body.status ?? "active",
    note: body.note ?? "",
  });
  return NextResponse.json({ hotword });
}
