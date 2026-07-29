"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type CurrentUser = {
  accountName: string;
  displayName: string;
  mustChangePassword: boolean;
};

export default function SessionNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);

  const isLoginPage = pathname === "/login";
  const isProtectedPage = pathname === "/" || pathname === "/admin" || pathname.startsWith("/admin/") || pathname === "/change-password";

  useEffect(() => {
    if (isLoginPage || !isProtectedPage) return;

    let disposed = false;
    fetch("/api/auth/me")
      .then(async (res) => {
        if (res.status === 401) {
          await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
          return { unauthorized: true };
        }
        if (!res.ok) return { unauthorized: true };
        return res.json();
      })
      .then((data) => {
        if (disposed) return;
        if (data?.unauthorized || !data?.user) {
          const next = encodeURIComponent(pathname);
          router.replace(`/login?next=${next}`);
          router.refresh();
          return;
        }
        setUser(data.user);
        if (data.user.mustChangePassword && pathname !== "/change-password") {
          router.replace("/change-password");
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
    };
  }, [isLoginPage, isProtectedPage, pathname, router]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    router.replace("/login");
    router.refresh();
  };

  if (isLoginPage || !user) return null;

  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-sm backdrop-blur">
      <span className="max-w-40 truncate">{user.displayName || user.accountName}</span>
      <button onClick={logout} className="rounded border border-slate-200 px-2 py-1 text-slate-500 hover:bg-slate-50">
        退出
      </button>
    </div>
  );
}
