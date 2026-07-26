import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  const content = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  });
  return env;
}

export async function POST(req: NextRequest) {
  try {
    const { transcript } = await req.json();
    if (!transcript) {
      return NextResponse.json({ error: "No transcript provided" }, { status: 400 });
    }

    const env = loadEnv();
    const apiKey = env.DASHSCOPE_API_KEY;

    const prompt = `你是一个专业的会议纪要整理助手。请根据以下会议转写文字，整理出一份结构清晰的会议纪要。

要求：
1. 提取会议的核心议题和讨论要点
2. 整理出关键决定和结论
3. 列出待办事项（如有）
4. 语言简洁专业，去除口语化的重复和语气词
5. 使用中文输出

会议转写内容：
${transcript}

请输出整理后的会议纪要：`;

    const response = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "qwen-plus",
          messages: [
            { role: "system", content: "你是一个专业的会议纪要整理助手。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("DashScope API error:", err);
      return NextResponse.json({ error: `LLM API error: ${response.status}` }, { status: 500 });
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content || "生成失败";

    return NextResponse.json({ summary });
  } catch (error) {
    console.error("Summarize error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
