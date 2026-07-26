"use client";

import { useState, useEffect, useCallback } from "react";

interface HotWord {
  id: string;
  text: string;
  weight: number;
}

interface Props {
  onChange?: (words: string[]) => void;
}

const STORAGE_KEY = "meeting-hotwords";

export default function HotWordManager({ onChange }: Props) {
  const [words, setWords] = useState<HotWord[]>([]);
  const [newWord, setNewWord] = useState("");
  const [newWeight, setNewWeight] = useState(4);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setWords(JSON.parse(saved));
      }
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
    onChange?.(words.map((w) => w.text));
  }, [words, onChange]);

  const addWord = () => {
    const text = newWord.trim();
    if (!text) return;
    if (words.some((w) => w.text === text)) return;

    setWords((prev) => [
      ...prev,
      { id: `hw-${Date.now()}`, text, weight: newWeight },
    ]);
    setNewWord("");
  };

  const removeWord = (id: string) => {
    setWords((prev) => prev.filter((w) => w.id !== id));
  };

  const clearAll = () => {
    setWords([]);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-500">热词增强</h3>
        {words.length > 0 && (
          <button onClick={clearAll} className="text-xs text-slate-400 hover:text-red-500">
            清空
          </button>
        )}
      </div>

      <div className="mb-2 flex gap-1">
        <input
          type="text"
          value={newWord}
          onChange={(e) => setNewWord(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addWord()}
          placeholder="输入热词..."
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs focus:border-brand focus:outline-none"
        />
        <button
          onClick={addWord}
          disabled={!newWord.trim()}
          className="shrink-0 rounded bg-brand px-2 py-1 text-xs text-white hover:bg-brand-dark disabled:opacity-50"
        >
          添加
        </button>
      </div>

      {words.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {words.map((w) => (
            <span
              key={w.id}
              className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
            >
              {w.text}
              <button
                onClick={() => removeWord(w.id)}
                className="ml-0.5 text-slate-400 hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {words.length > 0 && (
        <p className="mt-1 text-[10px] text-slate-400">
          共 {words.length} 个热词，识别时自动增强
        </p>
      )}
    </div>
  );
}
