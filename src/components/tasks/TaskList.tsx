'use client';

import { useState } from 'react';

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

interface TaskListProps {
  tasks: Task[];
  onUpdate: () => void;
}

export default function TaskList({ tasks, onUpdate }: TaskListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Task>>({});

  const handleProgressChange = async (taskId: string, progress: number) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/progress`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress }),
      });

      if (res.ok) {
        onUpdate();
      }
    } catch (err) {
      alert('更新进度失败');
    }
  };

  const handleDelete = async (taskId: string) => {
    if (!confirm('确定要删除这个任务吗？')) return;

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        onUpdate();
      }
    } catch (err) {
      alert('删除失败');
    }
  };

  const handleEdit = (task: Task) => {
    setEditingId(task._id);
    setEditForm({
      title: task.title,
      assignee: task.assignee,
      priority: task.priority,
      deadline: task.deadline,
    });
  };

  const handleSaveEdit = async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });

      if (res.ok) {
        setEditingId(null);
        onUpdate();
      }
    } catch (err) {
      alert('更新失败');
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high':
        return 'bg-red-100 text-red-700';
      case 'medium':
        return 'bg-yellow-100 text-yellow-700';
      case 'low':
        return 'bg-green-100 text-green-700';
      default:
        return 'bg-slate-100 text-slate-700';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'done':
        return 'bg-green-100 text-green-700';
      case 'in_progress':
        return 'bg-blue-100 text-blue-700';
      default:
        return 'bg-slate-100 text-slate-700';
    }
  };

  const isOverdue = (deadline: string | null) => {
    if (!deadline) return false;
    return new Date(deadline) < new Date() && deadline !== null;
  };

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
        <div className="text-4xl">📋</div>
        <p className="mt-4 text-slate-500">暂无任务</p>
        <p className="text-sm text-slate-400">
          点击"导入任务"从会议纪要中提取任务
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => (
        <div
          key={task._id}
          className={`rounded-xl border bg-white p-4 transition ${
            isOverdue(task.deadline) && task.status !== 'done'
              ? 'border-red-300'
              : 'border-slate-200'
          }`}
        >
          {editingId === task._id ? (
            <div className="space-y-3">
              <input
                type="text"
                value={editForm.title || ''}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, title: e.target.value }))
                }
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={editForm.assignee || ''}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      assignee: e.target.value,
                    }))
                  }
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="执行人"
                />
                <select
                  value={editForm.priority || 'medium'}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      priority: e.target.value as any,
                    }))
                  }
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                </select>
                <input
                  type="date"
                  value={
                    editForm.deadline
                      ? new Date(editForm.deadline).toISOString().split('T')[0]
                      : ''
                  }
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      deadline: e.target.value || null,
                    }))
                  }
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setEditingId(null)}
                  className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
                >
                  取消
                </button>
                <button
                  onClick={() => handleSaveEdit(task._id)}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h4
                    className={`font-medium ${
                      task.status === 'done'
                        ? 'text-slate-400 line-through'
                        : 'text-slate-800'
                    }`}
                  >
                    {task.title}
                  </h4>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    {task.assignee && (
                      <span className="text-slate-600">
                        👤 {task.assignee}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${getPriorityColor(
                        task.priority
                      )}`}
                    >
                      {task.priority === 'high'
                        ? '高'
                        : task.priority === 'medium'
                        ? '中'
                        : '低'}
                    </span>
                    {task.deadline && (
                      <span
                        className={`${
                          isOverdue(task.deadline) && task.status !== 'done'
                            ? 'text-red-600 font-medium'
                            : 'text-slate-500'
                        }`}
                      >
                        📅{' '}
                        {new Date(task.deadline).toLocaleDateString('zh-CN')}
                        {isOverdue(task.deadline) && task.status !== 'done'
                          ? ' (已逾期)'
                          : ''}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${getStatusColor(
                        task.status
                      )}`}
                    >
                      {task.status === 'done'
                        ? '已完成'
                        : task.status === 'in_progress'
                        ? '进行中'
                        : '待办'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleEdit(task)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => handleDelete(task._id)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  >
                    🗑️
                  </button>
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-slate-500">进度</span>
                  <span className="font-medium text-slate-700">
                    {task.progress}%
                  </span>
                </div>
                <div className="relative">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={task.progress}
                    onChange={(e) =>
                      handleProgressChange(task._id, parseInt(e.target.value))
                    }
                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-blue-600"
                  />
                  <div
                    className="absolute left-0 top-0 h-2 rounded-full bg-blue-600"
                    style={{ width: `${task.progress}%` }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
