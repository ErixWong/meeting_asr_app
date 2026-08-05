import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";
import { authenticateUser, createAuthSession, getActorRoleKeys } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const actor = await authenticateUser(body.accountName, body.password);

  if (!actor) {
    return NextResponse.json({ error: "Invalid account or password" }, { status: 401 });
  }

  const session = createAuthSession(actor.id);
  const response = NextResponse.json({
    user: {
      id: actor.id,
      accountName: actor.accountName,
      displayName: actor.displayName,
      mustChangePassword: Boolean(actor.mustChangePassword),
      roles: getActorRoleKeys(actor.id, actor.status),
    },
  });

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
}
