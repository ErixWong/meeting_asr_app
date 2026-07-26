'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import TaskList from '@/components/tasks/TaskList';
import TaskFilter from '@/components/tasks/TaskFilter';

interface Task {
  _id: string;
  title: string;
  assignee: string;
  priority: 'high' | 'medium' | 'low';
  deadline: string | null;
  progress: number;
  status: 'todo' | 'in_progress' | 'done';
  createdAt: string;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filters, setFilters] = useState({
    assignee: '',
    priority: '',
    status: '',
    overdue: false,
  });
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.assignee) params.set('assignee', filters.assignee);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.status) params.set('status', filters.status);
      if (filters.overdue) params.set('overdue', 'true');

      const res = await fetch(`/api/tasks?${params.toString()}`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (err) {
      console.error('获取任务失败:', err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (filters.assignee) params.set('assignee', filters.assignee);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.status) params.set('status', filters.status);
    window.open(`/api/tasks/export?${params.toString()}`, '_blank');
  };

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
          <h1 className="text-lg font-semibold text-slate-800">📋 任务管理</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/tasks/import"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            + 导入任务
          </Link>
          <button
            onClick={handleExport}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            📥 导出Excel
          </button>
          <Link
            href="/dashboard"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            📊 统计
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-auto bg-slate-50 p-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6">
            <TaskFilter filters={filters} onChange={setFilters} />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            </div>
          ) : (
            <TaskList tasks={tasks} onUpdate={fetchTasks} />
          )}
        </div>
      </main>
    </div>
  );
}
