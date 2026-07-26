import { NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/admin-store";

export async function GET() {
  return NextResponse.json(getRuntimeConfig());
}
