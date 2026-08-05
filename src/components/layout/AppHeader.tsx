"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { performLogout, useAuthSession } from "@/lib/use-auth-session";

type HeaderConfig = {
  title: string;
  action?: {
    href: string;
    label: string;
    adminOnly?: boolean;
  };
};

function getHeaderConfig(pathname: string): HeaderConfig | null {
  if (pathname === "/") {
    return {
      title: "🎙 智能会议纪要系统",
      action: { href: "/admin", label: "⚙ 管理", adminOnly: true },
    };
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return {
      title: "⚙ 系统管理",
      action: { href: "/", label: "← 返回主界面" },
    };
  }

  return null;
}

export default function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();

  const isLoginPage = pathname === "/login";
  const isProtectedPage = pathname === "/" || pathname === "/admin" || pathname.startsWith("/admin/") || pathname === "/change-password";
  const headerConfig = useMemo(() => getHeaderConfig(pathname), [pathname]);
  const { user, loading, setUser } = useAuthSession(isProtectedPage);
  const isAdmin = Boolean(user?.roles?.includes("system_admin"));

  useEffect(() => {
    if (isLoginPage || !isProtectedPage) return;
    if (loading) return;

    if (!user) {
      const next = encodeURIComponent(pathname);
      router.replace(`/login?next=${next}`);
      router.refresh();
      return;
    }

    if (user.mustChangePassword && pathname !== "/change-password") {
      router.replace("/change-password");
      return;
    }

    if (!user.mustChangePassword && pathname === "/change-password") {
      router.replace("/");
      router.refresh();
    }
  }, [isLoginPage, isProtectedPage, loading, pathname, router, user]);

  const logout = async () => {
    await performLogout();
    setUser(null);
    window.location.replace("/login");
  };

  if (!headerConfig) return null;

  return (
    <header className="border-b border-slate-200 bg-white px-6 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="text-lg font-semibold text-slate-800">{headerConfig.title}</div>
          {headerConfig.action && (!headerConfig.action.adminOnly || isAdmin) && (
            <Link
              href={headerConfig.action.href}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              {headerConfig.action.label}
            </Link>
          )}
        </div>

        {user && (
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-sm">
            <span className="max-w-40 truncate">{user.displayName || user.accountName}</span>
            <button
              onClick={logout}
              className="rounded border border-slate-200 px-2 py-1 text-slate-500 hover:bg-slate-50"
            >
              退出
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
