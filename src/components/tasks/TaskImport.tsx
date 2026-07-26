'use client';

import { useState, useRef } from 'react';

interface ExtractedTask {
  title: string;
  assignee: string;
  priority: 'high' | 'medium' | 'low';
  deadline: string;
  rawText: string;
  selected: boolean;
}

interface TaskImportProps {
  onImportComplete: () => void;
}

export default function TaskImport({ onImportComplete }: TaskImportProps) {
  const [inputType, setInputType] = useState<'paste' | 'word'>('paste');
  const [inputText, setInputText] = useState('');
  const [tasks, setTasks] = useState<ExtractedTask[]>([]);
  const [extractionId, setExtractionId] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.docx') && !file.name.endsWith('.doc')) {
      alert('请上传Word文档（.docx或.doc格式）');
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/tasks/parse-word', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (data.text) {
        setInputText(data.text);
        setInputType('word');
      }
    } catch (err) {
      alert('文件解析失败');
    } finally {
      setLoading(false);
    }
  };

  const handleExtract = async () => {
    if (!inputText.trim()) {
      alert('请先输入或上传文本内容');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/tasks/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText,
          inputType,
        }),
      });

      const data = await res.json();
      if (data.tasks) {
        setTasks(data.tasks);
        setExtractionId(data.extractionId);
      }
    } catch (err) {
      alert('任务提取失败');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTask = (index: number) => {
    setTasks((prev) =>
      prev.map((t, i) => (i === index ? { ...t, selected: !t.selected } : t))
    );
  };

  const handleUpdateTask = (index: number, field: string, value: string) => {
    setTasks((prev) =>
      prev.map((t, i) => (i === index ? { ...t, [field]: value } : t))
    );
  };

  const handleConfirmImport = async () => {
    const selectedTasks = tasks.filter((t) => t.selected);
    if (selectedTasks.length === 0) {
      alert('请至少选择一个任务');
      return;
    }

    setImporting(true);
    try {
      const tasksToImport = selectedTasks.map((t) => ({
        title: t.title,
        assignee: t.assignee,
        priority: t.priority,
        deadline: t.deadline ? new Date(t.deadline) : null,
        progress: 0,
        status: 'todo',
        source: inputType,
        extractionId: extractionId,
        confirmed: true,
      }));

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: tasksToImport }),
      });

      if (res.ok) {
        alert(`成功导入 ${selectedTasks.length} 个任务`);
        setInputText('');
        setTasks([]);
        setExtractionId('');
        onImportComplete();
      }
    } catch (err) {
      alert('导入失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <button
          onClick={() => setInputType('paste')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
            inputType === 'paste'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          粘贴文本
        </button>
        <button
          onClick={() => setInputType('word')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
            inputType === 'word'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          上传Word
        </button>
      </div>

      {inputType === 'word' && (
        <div className="rounded-xl border-2 border-dashed border-slate-300 p-8 text-center">
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,.doc"
            className="hidden"
            onChange={handleFileUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="text-blue-600 hover:underline"
          >
            {loading ? '解析中...' : '点击上传Word文档'}
          </button>
          <p className="mt-2 text-sm text-slate-400">
            支持 .docx 和 .doc 格式
          </p>
        </div>
      )}

      <textarea
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        placeholder="请粘贴会议纪要内容..."
        className="h-48 w-full rounded-xl border border-slate-200 p-4 text-sm focus:border-blue-500 focus:outline-none"
        disabled={loading}
      />

      <button
        onClick={handleExtract}
        disabled={loading || !inputText.trim()}
        className="w-full rounded-lg bg-blue-600 py-3 font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'AI解析中...' : '开始解析'}
      </button>

      {tasks.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-medium text-slate-800">
            解析结果（可编辑）- 共 {tasks.length} 条任务
          </h3>

          <div className="space-y-3">
            {tasks.map((task, index) => (
              <div
                key={index}
                className={`rounded-xl border p-4 transition ${
                  task.selected
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={task.selected}
                    onChange={() => handleToggleTask(index)}
                    className="mt-1 h-4 w-4 rounded"
                  />
                  <div className="flex-1 space-y-2">
                    <input
                      type="text"
                      value={task.title}
                      onChange={(e) =>
                        handleUpdateTask(index, 'title', e.target.value)
                      }
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                      placeholder="任务内容"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={task.assignee}
                        onChange={(e) =>
                          handleUpdateTask(index, 'assignee', e.target.value)
                        }
                        className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                        placeholder="执行人"
                      />
                      <select
                        value={task.priority}
                        onChange={(e) =>
                          handleUpdateTask(index, 'priority', e.target.value)
                        }
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                      >
                        <option value="high">高优先级</option>
                        <option value="medium">中优先级</option>
                        <option value="low">低优先级</option>
                      </select>
                      <input
                        type="date"
                        value={task.deadline}
                        onChange={(e) =>
                          handleUpdateTask(index, 'deadline', e.target.value)
                        }
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    {task.rawText && (
                      <p className="text-xs text-slate-400">
                        原文：{task.rawText}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between rounded-xl bg-slate-100 p-4">
            <span className="text-sm text-slate-600">
              已选择 {tasks.filter((t) => t.selected).length} 条任务
            </span>
            <button
              onClick={handleConfirmImport}
              disabled={importing || tasks.filter((t) => t.selected).length === 0}
              className="rounded-lg bg-green-600 px-6 py-2 font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
            >
              {importing ? '导入中...' : '确认入库'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
