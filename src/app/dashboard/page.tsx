'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import StatsCard from '@/components/tasks/StatsCard';

interface Stats {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
  overdue: number;
  upcoming: Array<{
    _id: string;
    title: string;
    assignee: string;
    deadline: string;
    daysLeft: number;
  }>;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({
    total: 0,
    todo: 0,
    inProgress: 0,
    done: 0,
    overdue: 0,
    upcoming: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        const tasks = data.tasks || [];

        const now = new Date();
        const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const overdue = tasks.filter(
          (t: any) =>
            t.deadline &&
            new Date(t.deadline) < now &&
            t.status !== 'done'
        );

        const upcoming = tasks
          .filter(
            (t: any) =>
              t.deadline &&
              new Date(t.deadline) >= now &&
              new Date(t.deadline) <= in7Days &&
              t.status !== 'done'
          )
          .map((t: any) => ({
            ...t,
            daysLeft: Math.ceil(
              (new Date(t.deadline).getTime() - now.getTime()) /
                (1000 * 60 * 60 * 24)
            ),
          }))
          .sort((a: any, b: any) => a.daysLeft - b.daysLeft);

        setStats({
          total: tasks.length,
          todo: tasks.filter((t: any) => t.status === 'todo').length,
          inProgress: tasks.filter((t: any) => t.status === 'in_progress')
            .length,
          done: tasks.filter((t: any) => t.status === 'done').length,
          overdue: overdue.length,
          upcoming: upcoming.slice(0, 5),
        });
      } catch (err) {
        console.error('获取统计失败:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  const handleCheckReminders = async () => {
    try {
      const res = await fetch('/api/reminders/check', { method: 'POST' });
      const data = await res.json();
      alert(`检查完成：发送${data.sent}封邮件，失败${data.failed}封`);
    } catch (err) {
      alert('检查提醒失败');
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-lg font-semibold text-slate-800 hover:text-blue-600"
          >
            🎙 智能会议纪要系统
          </Link>
          <span className="text-slate-300">|</span>
          <h1 className="text-lg font-semibold text-slate-800">📊 统计</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCheckReminders}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            🔔 检查提醒
          </button>
          <Link
            href="/tasks"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            📋 任务列表
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-auto bg-slate-50 p-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatsCard
              title="全部任务"
              value={stats.total}
              icon="📋"
              color="text-slate-800"
            />
            <StatsCard
              title="进行中"
              value={stats.inProgress}
              icon="🔄"
              color="text-blue-600"
            />
            <StatsCard
              title="已完成"
              value={stats.done}
              icon="✅"
              color="text-green-600"
            />
            <StatsCard
              title="已逾期"
              value={stats.overdue}
              icon="⚠️"
              color="text-red-600"
            />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h3 className="mb-4 text-lg font-semibold text-slate-800">
                即将到期任务（7天内）
              </h3>
              {stats.upcoming.length === 0 ? (
                <p className="text-center text-slate-400">暂无即将到期的任务</p>
              ) : (
                <div className="space-y-3">
                  {stats.upcoming.map((task) => (
                    <div
                      key={task._id}
                      className="flex items-center justify-between rounded-lg border border-slate-100 p-3"
                    >
                      <div>
                        <p className="font-medium text-slate-800">
                          {task.title}
                        </p>
                        <p className="text-sm text-slate-500">
                          {task.assignee || '未指定'}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 text-sm font-medium ${
                          task.daysLeft <= 1
                            ? 'bg-red-100 text-red-700'
                            : task.daysLeft <= 3
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-blue-100 text-blue-700'
                        }`}
                      >
                        {task.daysLeft === 0
                          ? '今天到期'
                          : task.daysLeft === 1
                          ? '明天到期'
                          : `${task.daysLeft}天后`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h3 className="mb-4 text-lg font-semibold text-slate-800">
                任务分布
              </h3>
              <div className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-slate-600">待办</span>
                    <span className="text-slate-800">
                      {stats.total > 0
                        ? Math.round((stats.todo / stats.total) * 100)
                        : 0}
                      %
                    </span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full bg-slate-500"
                      style={{
                        width: `${
                          stats.total > 0
                            ? (stats.todo / stats.total) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-slate-600">进行中</span>
                    <span className="text-slate-800">
                      {stats.total > 0
                        ? Math.round((stats.inProgress / stats.total) * 100)
                        : 0}
                      %
                    </span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full bg-blue-500"
                      style={{
                        width: `${
                          stats.total > 0
                            ? (stats.inProgress / stats.total) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-slate-600">已完成</span>
                    <span className="text-slate-800">
                      {stats.total > 0
                        ? Math.round((stats.done / stats.total) * 100)
                        : 0}
                      %
                    </span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full bg-green-500"
                      style={{
                        width: `${
                          stats.total > 0
                            ? (stats.done / stats.total) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
