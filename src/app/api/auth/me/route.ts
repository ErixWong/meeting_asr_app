import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/api-auth";
import { getActorRoleKeys } from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const actor = getAuthenticatedActor(req);
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: actor.id,
      accountName: actor.accountName,
      displayName: actor.displayName,
      mustChangePassword: Boolean(actor.mustChangePassword),
      roles: getActorRoleKeys(actor.id, actor.status),
    },
  });
}
