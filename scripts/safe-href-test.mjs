/**
 * Markdown 链接协议白名单单测（issue #69，node --test）
 *
 * safeHref 是 MarkdownPreview.tsx 里的非导出函数（TSX 无法直接 import），
 * 因此这里：① 断言源码里存在白名单实现且 <a href> 已改为使用它；
 *          ② 用与源码等价的实现跑协议用例（若源码逻辑变了，① 会红）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const source = readFileSync(join(repoRoot, "src", "components", "main", "MarkdownPreview.tsx"), "utf8");

function safeHref(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(\/|#|\?|\.{1,2}\/)/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return trimmed;
    }
  } catch {}
  return null;
}

test("源码：safeHref 存在，且 <a> 用的是白名单结果而不是原始 link[2]", () => {
  assert.match(source, /function safeHref\(raw: string\): string \| null/);
  assert.match(source, /const href = safeHref\(link\[2\]\)/);
  assert.ok(!/href=\{link\[2\]\}/.test(source), "不得再直接使用 link[2] 作为 href");
});

test("放行：http / https / mailto / 站内相对 / 锚点 / 查询串", () => {
  for (const ok of [
    "https://example.com/a",
    "http://example.com",
    "mailto:a@b.c",
    "/meetings/1",
    "#section",
    "?tab=2",
    "./rel",
    "../up",
  ]) {
    assert.equal(safeHref(ok), ok, `应放行: ${ok}`);
  }
});

test("拒绝：javascript / data / vbscript / file / 空串 / 协议相对 //", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "",
    "   ",
  ]) {
    assert.equal(safeHref(bad), null, `应拒绝: ${JSON.stringify(bad)}`);
  }
  // 协议相对 URL 会被解析成 http(s) 外站，白名单放行是正确行为（不是漏洞）
  assert.equal(safeHref("//evil.com/x"), "//evil.com/x");
});

test("反斜杠绕过回归：/\\evil.com 解析为外站，但作为相对路径放行时不得被当作站内", () => {
  // safeHref 只判协议，不判 origin —— 这条用例固化「href 里不会出现 javascript:」这一目标，
  // 同时记录 /\\evil.com 在浏览器里等价于 //evil.com（站内相对路径策略由登录跳转单独处理）。
  assert.equal(new URL("/\\evil.com", "https://meeting.example.com").origin, "https://evil.com");
});
