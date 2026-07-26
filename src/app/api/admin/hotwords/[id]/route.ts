import { NextRequest, NextResponse } from "next/server";
import { deleteHotword, updateHotword } from "@/lib/admin-store";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const hotword = updateHotword(params.id, {
    term: body.term,
    weight: body.weight === undefined ? undefined : Number(body.weight),
    status: body.status,
    note: body.note,
  });
  return NextResponse.json({ hotword });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  deleteHotword(params.id);
  return NextResponse.json({ ok: true });
}
