import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { listSettingsForAdmin, saveSettings } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  return NextResponse.json({ settings: listSettingsForAdmin() });
  });
}

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      if (!Array.isArray(body?.settings)) {
        return NextResponse.json({ error: "settings must be an array" }, { status: 400 });
      }
      saveSettings(body.settings);
      return NextResponse.json({ ok: true, settings: listSettingsForAdmin() });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to save settings" },
        { status: 400 }
      );
    }
  });
}
