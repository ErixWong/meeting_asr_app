import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/api-auth";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";
import { changeUserPassword, createAuthSession } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export async function POST(req: NextRequest) {
  const actor = getAuthenticatedActor(req);
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  try {
    await changeUserPassword(actor.accountName, body.currentPassword, body.nextPassword);
    const session = createAuthSession(actor.id);
    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: session.token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to change password" },
      { status: 400 }
    );
  }
}
