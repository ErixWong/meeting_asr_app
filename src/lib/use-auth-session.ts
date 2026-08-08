"use client";

import { useEffect, useState } from "react";

export type CurrentUser = {
  accountName: string;
  displayName: string;
  email: string;
  mustChangePassword: boolean;
  roles: string[];
};

export async function performLogout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
}

export function useAuthSession(enabled = true) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setUser(null);
      return;
    }

    let disposed = false;
    setLoading(true);

    fetch("/api/auth/me")
      .then(async (res) => {
        if (res.status === 401) {
          await performLogout();
          return { unauthorized: true };
        }
        if (!res.ok) return { unauthorized: true };
        return res.json();
      })
      .then((data) => {
        if (disposed) return;
        setUser(data?.unauthorized || !data?.user ? null : data.user);
      })
      .catch(() => {
        if (disposed) return;
        setUser(null);
      })
      .finally(() => {
        if (disposed) return;
        setLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [enabled]);

  return {
    user,
    loading,
    setUser,
  };
}
