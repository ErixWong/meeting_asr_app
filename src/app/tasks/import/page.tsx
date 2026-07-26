'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TaskImport from '@/components/tasks/TaskImport';

export default function TaskImportPage() {
  const router = useRouter();

  const handleImportComplete = () => {
    router.push('/tasks');
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
          <h1 className="text-lg font-semibold text-slate-800">
            📥 导入任务
          </h1>
        </div>
        <Link
          href="/tasks"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
        >
          返回任务列表
        </Link>
      </header>

      <main className="flex-1 overflow-auto bg-slate-50 p-6">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="mb-4 text-lg font-semibold text-slate-800">
              从会议纪要导入任务
            </h2>
            <p className="mb-6 text-sm text-slate-500">
              支持粘贴文本或上传Word文档，AI将自动识别并提取任务
            </p>
            <TaskImport onImportComplete={handleImportComplete} />
          </div>
        </div>
      </main>
    </div>
  );
}
