import { NextResponse } from "next/server";
import {
  getActorByAccountName,
  getActorBySessionToken,
  getActorRoleKeys,
  runWithActor,
} from "@/lib/admin-store";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";

export const ADMIN_ROLES = ["system_admin"];
export const BUSINESS_ROLES = ["user", "system_admin"];
export const CONTENT_ROLES = BUSINESS_ROLES;

function readCookie(req: Request, name: string) {
  const cookieHeader = req.headers.get("cookie") || "";
  const cookies = cookieHeader.split(";").map((item) => item.trim());
  const match = cookies.find((item) => item.startsWith(`${name}=`));
  if (!match) return "";
  return decodeURIComponent(match.slice(name.length + 1));
}

export function getAuthenticatedActor(req: Request) {
  const sessionToken = readCookie(req, SESSION_COOKIE_NAME);
  const sessionActor = getActorBySessionToken(sessionToken);
  if (sessionActor) {
    return { ...sessionActor, mustChangePassword: Boolean(sessionActor.mustChangePassword) };
  }

  const accountName = getRequestAccountName(req);
  if (!accountName) return null;

  const actor = getActorByAccountName(accountName);
  if (!actor || actor.status !== "active") return null;
  return { ...actor, mustChangePassword: Boolean(actor.mustChangePassword) };
}

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
  const actor = getAuthenticatedActor(req);
  if (!actor) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (actor.mustChangePassword) {
    return {
      response: NextResponse.json(
        { error: "Password change required", mustChangePassword: true },
        { status: 403 }
      ),
    };
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
