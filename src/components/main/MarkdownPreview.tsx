"use client";

import { ReactNode } from "react";

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; code: string; language?: string }
  | { type: "table"; headers: string[]; alignments: Array<"left" | "center" | "right">; rows: string[][] }
  | { type: "hr" };

interface Props {
  markdown: string;
}

function splitTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseAlignment(cell: string): "left" | "center" | "right" | null {
  const normalized = cell.trim().replace(/\s+/g, "");
  if (!/^:?-{3,}:?$/.test(normalized)) return null;
  if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
  if (normalized.endsWith(":")) return "right";
  return "left";
}

function isTableSeparator(line: string) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => parseAlignment(cell));
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return Boolean(
    /^```/.test(line.trim()) ||
      /^#{1,6}\s+/.test(line) ||
      /^>\s?/.test(line) ||
      /^(\s*)([-*+]\s+|\d+\.\s+)/.test(line) ||
      /^-{3,}\s*$/.test(line.trim()) ||
      (line.includes("|") && isTableSeparator(next))
  );
}

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineStart = index;

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", code: codeLines.join("\n"), language });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^-{3,}\s*$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = splitTableRow(line);
      const alignments = splitTableRow(lines[index + 1]).map((cell) => parseAlignment(cell) ?? "left");
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, alignments, rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]\s+|\d+\.\s+)(.*)$/);
    if (listMatch) {
      const ordered = /\d+\.\s+/.test(listMatch[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^(\s*)([-*+]\s+|\d+\.\s+)(.*)$/);
        if (!itemMatch || /\d+\.\s+/.test(itemMatch[2]) !== ordered) break;
        items.push(itemMatch[3].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (index === lineStart) {
      index += 1;
      continue;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderInline(text: string) {
  const parts: ReactNode[] = [];
  const tokenPattern = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      parts.push(
        <a key={parts.length} href={link[2]} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2">
          {link[1]}
        </a>
      );
    } else if (token.startsWith("`")) {
      parts.push(
        <code key={parts.length} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.92em] text-slate-800">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      parts.push(<strong key={parts.length}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<em key={parts.length}>{token.slice(1, -1)}</em>);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function alignmentClass(alignment: "left" | "center" | "right") {
  if (alignment === "center") return "text-center";
  if (alignment === "right") return "text-right";
  return "text-left";
}

export default function MarkdownPreview({ markdown }: Props) {
  const blocks = parseMarkdown(markdown);

  return (
    <div className="space-y-4 text-[15px] leading-relaxed text-slate-700">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const HeadingTag = `h${block.level}` as keyof JSX.IntrinsicElements;
          const sizeClass =
            block.level === 1
              ? "text-2xl"
              : block.level === 2
                ? "text-xl"
                : block.level === 3
                  ? "text-lg"
                  : "text-base";
          return (
            <HeadingTag key={index} className={`${sizeClass} font-semibold leading-snug text-slate-900`}>
              {renderInline(block.text)}
            </HeadingTag>
          );
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={index} className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-6`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ListTag>
          );
        }

        if (block.type === "blockquote") {
          return (
            <blockquote key={index} className="border-l-4 border-slate-300 bg-slate-50 py-2 pl-4 pr-3 text-slate-600">
              {block.text.split("\n").map((line, lineIndex) => (
                <p key={lineIndex}>{renderInline(line)}</p>
              ))}
            </blockquote>
          );
        }

        if (block.type === "code") {
          return (
            <pre key={index} className="overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
              <code>{block.code}</code>
            </pre>
          );
        }

        if (block.type === "table") {
          return (
            <div key={index} className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full border-collapse text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th
                        key={headerIndex}
                        className={`border-b border-slate-200 px-3 py-2 font-semibold text-slate-700 ${alignmentClass(block.alignments[headerIndex] ?? "left")}`}
                      >
                        {renderInline(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="odd:bg-white even:bg-slate-50/60">
                      {block.headers.map((_, cellIndex) => (
                        <td
                          key={cellIndex}
                          className={`border-t border-slate-100 px-3 py-2 align-top text-slate-700 ${alignmentClass(block.alignments[cellIndex] ?? "left")}`}
                        >
                          {renderInline(row[cellIndex] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "hr") {
          return <hr key={index} className="border-slate-200" />;
        }

        return <p key={index}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}
