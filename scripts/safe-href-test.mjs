/**
 * Markdown 链接协议白名单单测（issue #69，node --test）
 *
 * 直接跑**真实实现** `src/lib/safe-href.ts`（Node 22.18+ 原生类型擦除），
 * 不再测一份副本 —— 副本测试有假绿风险：实现放开了危险协议，只要签名和调用点没变，
 * 测试仍然通过。
 *
 * 另外断言「渲染层确实用了它」：`MarkdownPreview.tsx` 必须 import `safeHref` 且
 * 不得再直接把 `link[2]` 塞进 `href`。否则白名单写了也没接上。
 *
 * 运行：npm run test:safe-href
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;

const { safeHref } = await import(pathToFileURL(join(repoRoot, "src/lib/safe-href.ts")).href);
const previewSource = readFileSync(
  join(repoRoot, "src", "components", "main", "MarkdownPreview.tsx"),
  "utf8"
);

test("接线：MarkdownPreview 必须 import 真实实现，且不再直接使用 link[2] 作为 href", () => {
  assert.match(
    previewSource,
    /import \{ safeHref \} from "@\/lib\/safe-href"/,
    "必须从 @/lib/safe-href 引入白名单函数"
  );
  assert.match(
    previewSource,
    /const href = safeHref\(link\[2\]\)/,
    "必须用白名单结果替换原始链接"
  );
  assert.ok(
    !/href=\{link\[2\]\}/.test(previewSource),
    "不得再直接把 link[2] 当 href"
  );
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

test("拒绝：javascript / data / vbscript / file / 空串 / 纯空白", () => {
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
});

test("协议相对 URL（//host/path）放行：它只是外链，不执行脚本", () => {
  // 这条**故意**是放行：`//evil.com/x` 解析成 https://evil.com/x，是一个普通外链，
  // 不会执行脚本、也不会自动跳转（`<a>` 需要用户点击，且带 rel="noreferrer"）。
  // 真正的 XSS 面是 javascript:/data:，已在上一条断言里拒掉。
  assert.equal(safeHref("//evil.com/x"), "//evil.com/x");
});

test("反斜杠回归：/\\evil.com 在浏览器里等价于 //evil.com（登录跳转由 URL origin 校验单独处理）", () => {
  assert.equal(new URL("/\\evil.com", "https://meeting.example.com").origin, "https://evil.com");
});
