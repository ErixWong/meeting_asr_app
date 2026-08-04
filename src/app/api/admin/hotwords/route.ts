import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { createHotword, listHotwords } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  return NextResponse.json({ hotwords: listHotwords() });
  });
}

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      const hotword = createHotword({
        term: body.term,
        weight: Number(body.weight ?? 10),
        status: body.status ?? "active",
        note: body.note ?? "",
      });
      return NextResponse.json({ hotword });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create hotword" },
        { status: 400 }
      );
    }
  });
}
