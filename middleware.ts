import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";

const PUBLIC_PATHS = ["/login"];
const AUTH_PATHS = ["/api/auth"];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isPublic =
    PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ||
    AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (isPublic) return NextResponse.next();

  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (hasSession) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/", "/admin/:path*", "/change-password"],
};
