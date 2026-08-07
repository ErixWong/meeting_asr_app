"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAuthSession } from "@/lib/use-auth-session";

export default function LoginPage() {
  const { user, loading } = useAuthSession(true);
  const [accountName, setAccountName] = useState("");
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
      window.location.replace("/change-password");
      return;
    }

    window.location.replace(getNextUrl());
  }, [loading, user]);

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
        window.location.replace("/change-password");
        return;
      }

      window.location.replace(getNextUrl());
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen overflow-y-auto bg-[#eef3f8] p-3 text-slate-900 sm:p-5 lg:p-8">
      <div className="mx-auto grid min-h-[calc(100vh-1.5rem)] max-w-6xl overflow-hidden rounded-[2rem] bg-white shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)] sm:min-h-[calc(100vh-2.5rem)] lg:grid-cols-[1.08fr_0.92fr]">
        <section className="relative hidden overflow-hidden bg-[#10253f] p-10 text-white lg:flex lg:flex-col lg:justify-between xl:p-14">
          <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-blue-500/20 blur-3xl" />
          <div className="relative">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-end justify-center gap-1 rounded-2xl border border-cyan-200/30 bg-cyan-300/10 px-2.5 pb-2">
                {["h-3", "h-6", "h-9", "h-5", "h-7"].map((height, index) => (
                  <span key={index} className={`w-1 rounded-full bg-cyan-300 ${height}`} />
                ))}
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/80">Meeting Notes</p>
                <p className="mt-1 text-sm text-white/60">智能会议纪要系统</p>
              </div>
            </div>

            <div className="mt-24 max-w-lg">
              <p className="mb-5 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.24em] text-cyan-200">
                <span className="h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_0_5px_rgba(252,211,77,0.12)]" />
                Your meeting, in focus
              </p>
              <h1 className="text-5xl font-semibold leading-[1.05] tracking-[-0.04em] xl:text-6xl">
                让每一句
                <br />
                都有回声。
              </h1>
              <p className="mt-7 max-w-md text-base leading-7 text-slate-300">
                从实时转写到结构化纪要，把会议里真正重要的内容留下来，随时回到现场。
              </p>
            </div>
          </div>

          <div className="relative">
            <div className="mb-5 flex h-20 items-center gap-1.5 border-y border-white/10">
              {[18, 30, 24, 46, 64, 38, 26, 52, 72, 44, 28, 57, 36, 22, 48, 30, 18, 42, 26, 14].map((height, index) => (
                <span key={index} className="w-1 rounded-full bg-cyan-300/70" style={{ height }} />
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-slate-400">
              <span>Live workspace</span>
              <span>00:42:18</span>
            </div>
          </div>
        </section>

        <section className="relative flex min-h-[calc(100vh-1.5rem)] flex-col justify-center px-6 py-10 sm:px-12 lg:min-h-0 lg:px-16 xl:px-24">
          <div className="mx-auto w-full max-w-md">
            <div className="mb-12 flex items-center gap-3 lg:hidden">
              <div className="flex h-10 w-10 items-end justify-center gap-1 rounded-xl bg-[#10253f] px-2 pb-2">
                {["h-3", "h-5", "h-7", "h-4", "h-6"].map((height, index) => (
                  <span key={index} className={`w-1 rounded-full bg-cyan-300 ${height}`} />
                ))}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">Meeting Notes</p>
                <p className="mt-0.5 text-sm font-medium text-slate-800">智能会议纪要系统</p>
              </div>
            </div>

            <div className="mb-9">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-brand">Welcome back</p>
              <h2 className="text-3xl font-semibold tracking-[-0.04em] text-slate-900 sm:text-4xl">进入你的工作台</h2>
              <p className="mt-3 text-sm leading-6 text-slate-500">使用账号登录，继续整理下一场重要会议。</p>
            </div>

            <form onSubmit={submit} className="space-y-5">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">账号</span>
                <div className="group flex items-center rounded-xl border border-slate-200 bg-slate-50 px-4 transition focus-within:border-brand focus-within:bg-white focus-within:ring-4 focus-within:ring-blue-100">
                  <span className="mr-3 text-slate-400 transition group-focus-within:text-brand">@</span>
                  <input
                    value={accountName}
                    onChange={(event) => setAccountName(event.target.value)}
                    autoComplete="username"
                    className="w-full bg-transparent py-3.5 text-sm outline-none placeholder:text-slate-400"
                    placeholder="输入账号"
                  />
                </div>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">密码</span>
                <div className="group flex items-center rounded-xl border border-slate-200 bg-slate-50 px-4 transition focus-within:border-brand focus-within:bg-white focus-within:ring-4 focus-within:ring-blue-100">
                  <span className="mr-3 text-slate-400 transition group-focus-within:text-brand">••</span>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    autoComplete="current-password"
                    className="w-full bg-transparent py-3.5 text-sm outline-none placeholder:text-slate-400"
                    placeholder="输入密码"
                  />
                </div>
              </label>

              {error && (
                <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-5 text-red-700">
                  <span className="mt-0.5 font-semibold">!</span>
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="group flex w-full items-center justify-center gap-3 rounded-xl bg-[#10253f] px-4 py-3.5 text-sm font-semibold text-white shadow-[0_12px_24px_-12px_rgba(16,37,63,0.8)] transition hover:-translate-y-0.5 hover:bg-[#17395d] hover:shadow-[0_16px_28px_-12px_rgba(16,37,63,0.8)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
              >
                <span>{submitting ? "正在验证..." : "进入工作台"}</span>
                {!submitting && <span className="text-lg leading-none transition-transform group-hover:translate-x-1">→</span>}
              </button>
            </form>

            <div className="mt-10 flex items-center justify-between border-t border-slate-100 pt-5 text-[11px] text-slate-400">
              <span>Secure workspace</span>
              <span>© 2026 Meeting Notes</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
