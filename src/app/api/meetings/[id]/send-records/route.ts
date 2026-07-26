import { NextResponse } from "next/server";
import { listMeetingSendRecords } from "@/lib/admin-store";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  return NextResponse.json({ sendRecords: listMeetingSendRecords(params.id) });
}
