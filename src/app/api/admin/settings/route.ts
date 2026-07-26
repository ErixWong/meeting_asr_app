import { NextRequest, NextResponse } from "next/server";
import { listSettings, saveSettings } from "@/lib/admin-store";

export async function GET() {
  return NextResponse.json({ settings: listSettings() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  saveSettings(Array.isArray(body.settings) ? body.settings : []);
  return NextResponse.json({ ok: true, settings: listSettings() });
}
