"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthSession } from "@/lib/use-auth-session";

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuthSession(true);
  const [accountName, setAccountName] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const getNextUrl = () => {
    const value = new URLSearchParams(window.location.search).get("next") || "/";
    return value.startsWith("/") && !value.startsWith("//") ? value : "/";
  };

  useEffect(() => {
    if (loading || !user) return;

    if (user.mustChangePassword) {
      router.replace("/change-password");
      return;
    }

    router.replace(getNextUrl());
    router.refresh();
  }, [loading, router, user]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountName, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || "登录失败");
      }

      if (data.user?.mustChangePassword) {
        router.replace("/change-password");
        return;
      }

      router.replace(getNextUrl());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">智能会议纪要系统</h1>
          <p className="mt-2 text-sm text-slate-500">使用管理员账号登录后继续。</p>
        </div>

        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-700">账号</span>
          <input
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
            autoComplete="username"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-700">密码</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </label>

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "登录中..." : "登录"}
        </button>

        <p className="mt-4 text-xs leading-5 text-slate-400">
          初始账号为 admin。生产环境请通过 BOOTSTRAP_ADMIN_PASSWORD 设置初始密码。
        </p>
      </form>
    </main>
  );
}
