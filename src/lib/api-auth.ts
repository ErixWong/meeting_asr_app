import { NextResponse } from "next/server";
import { getActorByAccountName, getActorRoleKeys, runWithActor } from "@/lib/admin-store";

export const ADMIN_ROLES = ["system_admin"];
export const CONTENT_MANAGER_ROLES = ["minutes_admin", "system_admin"];

function getRequestAccountName(req: Request) {
  if (process.env.NODE_ENV !== "production") {
    return (process.env.DEV_ACTOR_ACCOUNT || "").trim();
  }

  const sharedSecret = process.env.AUTH_PROXY_SHARED_SECRET;
  const providedSecret = req.headers.get("x-auth-proxy-secret");
  if (!sharedSecret || providedSecret !== sharedSecret) return "";

  return (req.headers.get("x-user-account") || req.headers.get("x-authenticated-user") || "").trim();
}

export function withRequiredRoles<T>(
  req: Request,
  roleKeys: string[],
  handler: () => T
) {
  const auth = authorizeAnyRole(req, roleKeys);
  if ("response" in auth) return auth.response;

  return runWithActor(auth.actor, handler);
}

function authorizeAnyRole(req: Request, roleKeys: string[]) {
  const accountName = getRequestAccountName(req);
  if (!accountName) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const actor = getActorByAccountName(accountName);
  if (!actor || actor.status !== "active") {
    return { response: NextResponse.json({ error: "Unauthorized", actor: accountName }, { status: 401 }) };
  }

  const currentRoleKeys = new Set(getActorRoleKeys(actor.id, actor.status));
  if (roleKeys.some((roleKey) => currentRoleKeys.has(roleKey))) {
    return { actor };
  }

  return {
    response: NextResponse.json(
      {
        error: "Forbidden",
        actor: actor.accountName,
        requiredRoles: roleKeys,
      },
      { status: 403 }
    ),
  };
}
