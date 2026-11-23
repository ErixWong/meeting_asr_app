/**
 * 未保存转写的离页拦截单测（issue #74-1，node --test）
 *
 * 直接跑**真实实现** `src/lib/unsaved-work.ts`（Node 22.18+ 原生类型擦除）。
 * 该模块零 import，所以用 `pathToFileURL` + 动态 import 即可，不需要 `@/` 解析钩子
 * （见同目录 recording-start-guard-test.mjs 的直连 import 写法）。
 *
 * 另加三条**源码结构守卫**：确认标志确实被首页同步、且顶栏与 /chat 两个离页入口
 * 都真的调用了 `confirmLeaveIfUnsaved()`，防止以后被删掉又留下「idle 状态离页丢数据」。
 *
 * 运行：npm run test:unsaved-work
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;

const { confirmLeaveIfUnsaved, getHasUnsavedWork, setHasUnsavedWork } = await import(
  pathToFileURL(join(repoRoot, "src/lib/unsaved-work.ts")).href
);

const pageSource = readFileSync(join(repoRoot, "src", "app", "page.tsx"), "utf8");
const headerSource = readFileSync(
  join(repoRoot, "src", "components", "layout", "AppHeader.tsx"),
  "utf8"
);

/**
 * 去掉行注释与块注释，避免「注释里提到」被当成真实调用
 * （验收 W5：只剥行注释时，块注释可以伪造结构匹配）。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const slash = line.indexOf("//");
      return slash === -1 ? line : line.slice(0, slash);
    })
    .join("\n");
}

test("初始状态：无未保存活，confirmLeaveIfUnsaved 放行且完全不打扰用户", () => {
  setHasUnsavedWork(false);
  assert.equal(getHasUnsavedWork(), false);
  let calls = 0;
  assert.equal(
    confirmLeaveIfUnsaved("任意提示", () => {
      calls += 1;
      return false;
    }),
    true
  );
  assert.equal(calls, 0, "没有未保存的活时不应该弹确认框");
});

test("setHasUnsavedWork(true) 之后 getHasUnsavedWork() 为 true", () => {
  setHasUnsavedWork(true);
  assert.equal(getHasUnsavedWork(), true);
});

test("有未保存 + 用户点「取消」：返回 false（应 preventDefault），且只问一次", () => {
  setHasUnsavedWork(true);
  let calls = 0;
  assert.equal(
    confirmLeaveIfUnsaved("离开吗？", () => {
      calls += 1;
      return false;
    }),
    false
  );
  assert.equal(calls, 1, "确认框必须被调用且只调用一次");
});

test("有未保存 + 用户点「确定」：返回 true（允许导航）", () => {
  setHasUnsavedWork(true);
  assert.equal(confirmLeaveIfUnsaved("离开吗？", () => true), true);
});

test("复位：setHasUnsavedWork(false) 之后重新放行且不再弹框", () => {
  setHasUnsavedWork(false);
  let calls = 0;
  assert.equal(
    confirmLeaveIfUnsaved("离开吗？", () => {
      calls += 1;
      return false;
    }),
    true
  );
  assert.equal(calls, 0, "标志复位后不应该再弹框");
  assert.equal(getHasUnsavedWork(), false);
});

test("默认 message 含「未保存」：防止以后被改成空提示", () => {
  setHasUnsavedWork(true);
  let seen = null;
  confirmLeaveIfUnsaved(undefined, (message) => {
    seen = message;
    return true;
  });
  assert.equal(typeof seen, "string", "必须把 message 传给确认框");
  assert.ok(seen.includes("未保存"), `默认提示必须说明是未保存内容，实际：${seen}`);
  setHasUnsavedWork(false);
});

test("源码结构守卫：AppHeader 的顶栏 Link 真的调用了 confirmLeaveIfUnsaved()", () => {
  const code = stripComments(headerSource);
  assert.match(
    code,
    /if \(!confirmLeaveIfUnsaved\(\)\) event\.preventDefault\(\);/,
    "顶栏链接必须有真实的 if (!confirmLeaveIfUnsaved()) event.preventDefault();（注释掉不算）"
  );
});

test("源码结构守卫：page.tsx 把 status/liveSegments 同步进 setHasUnsavedWork(", () => {
  const code = stripComments(pageSource);
  assert.match(
    code,
    /\n\s*setHasUnsavedWork\(\n?\s*status === "recording"/,
    "首页必须有一个把 status / liveSegments 写进标志的调用"
  );
  // 四个条件缺一不可：删掉任何一个都会让对应状态下的离页不再被拦（验收 W5）。
  // ⚠ 必须限定在 `setHasUnsavedWork(` 那一段里查，不能用全文件 includes ——
  // `status === "paused"` 在 beforeunload 和 /chat 的 onClick 里也出现，
  // 全文件查会让「从同步 effect 里删掉这个条件」测不出来（实测过）。
  const syncAt = code.indexOf("setHasUnsavedWork(");
  assert.notEqual(syncAt, -1, "找不到 setHasUnsavedWork( 调用");
  const syncBlock = code.slice(syncAt, syncAt + 400);
  for (const condition of [
    'status === "recording"',
    'status === "paused"',
    'status === "connecting"',
    "liveSegments.length > 0",
  ]) {
    assert.ok(
      syncBlock.includes(condition),
      `同步标志的判定里缺少条件 ${condition} —— 缺了它，该状态下的离页就不再被拦`
    );
  }
  assert.match(code, /setHasUnsavedWork\(false\)/, "卸载时必须清标志，避免其他页面残留 true");
});

test("源码结构守卫：/chat 链接的 onClick 内有 confirmLeaveIfUnsaved() 拦截", () => {
  const linkAt = pageSource.indexOf('href="/chat"');
  assert.notEqual(linkAt, -1, "找不到 /chat 链接");
  // 不能用 indexOf(">") 截属性区：`onClick={(event) =>` 里的 => 也是 >，会截太短。
  const linkEnd = pageSource.indexOf("</Link>", linkAt);
  assert.notEqual(linkEnd, -1, "找不到 /chat 链接的 </Link>");
  const link = stripComments(pageSource.slice(linkAt, linkEnd));
  assert.match(
    link,
    /if \(!confirmLeaveIfUnsaved\(\)\) \{/,
    "/chat 的 onClick 必须在录音硬拦截之外再叠一层未保存确认（注释掉不算）"
  );
  assert.match(
    link,
    /录音进行中，请先停止录音再切换页面/,
    "录音中的硬拦截必须保留（不能被未保存确认顶掉）"
  );
});
