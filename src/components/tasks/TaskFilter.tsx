'use client';

interface TaskFilterProps {
  filters: {
    assignee: string;
    priority: string;
    status: string;
    overdue: boolean;
  };
  onChange: (filters: any) => void;
}

export default function TaskFilter({ filters, onChange }: TaskFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        type="text"
        placeholder="搜索执行人..."
        value={filters.assignee}
        onChange={(e) => onChange({ ...filters, assignee: e.target.value })}
        className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />

      <select
        value={filters.priority}
        onChange={(e) => onChange({ ...filters, priority: e.target.value })}
        className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      >
        <option value="">全部优先级</option>
        <option value="high">高</option>
        <option value="medium">中</option>
        <option value="low">低</option>
      </select>

      <select
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value })}
        className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      >
        <option value="">全部状态</option>
        <option value="todo">待办</option>
        <option value="in_progress">进行中</option>
        <option value="done">已完成</option>
      </select>

      <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
        <input
          type="checkbox"
          checked={filters.overdue}
          onChange={(e) => onChange({ ...filters, overdue: e.target.checked })}
          className="rounded"
        />
        <span className="text-red-600">仅显示逾期</span>
      </label>

      {(filters.assignee || filters.priority || filters.status || filters.overdue) && (
        <button
          onClick={() =>
            onChange({
              assignee: '',
              priority: '',
              status: '',
              overdue: false,
            })
          }
          className="text-sm text-blue-600 hover:underline"
        >
          清除筛选
        </button>
      )}
    </div>
  );
}
