/**
 * 录音启动取消判定单测（issue #74-2，node --test）
 *
 * 直接跑**真实实现** `src/lib/recording-start-guard.ts`（Node 22.18+ 原生类型擦除）。
 * 该模块零 import，所以用 `pathToFileURL` + 动态 import 即可，不需要 `@/` 解析钩子
 * （见同目录 safe-href-test.mjs 的直连 import 写法）。
 *
 * 另加两条**源码结构守卫**：读 `src/app/page.tsx`，确认循环里确实接上了
 * `abortIfCancelled()` 检查点，防止以后有人把它删掉又留下「看不见的采集」泄漏。
 *
 * 运行：npm run test:recording-guard
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;

const { isStartCancelled } = await import(
  pathToFileURL(join(repoRoot, "src/lib/recording-start-guard.ts")).href
);

const pageSource = readFileSync(join(repoRoot, "src", "app", "page.tsx"), "utf8");

test("同一实例：isStartCancelled 返回 false（本轮未被取消）", () => {
  const clients = new Map([["mic", {}]]);
  assert.equal(isStartCancelled(clients, clients), false);
});

test("换成新 Map：返回 true（ref 已被取消路径替换）", () => {
  const clients = new Map([["mic", {}]]);
  const replacement = new Map();
  assert.equal(isStartCancelled(replacement, clients), true);
});

test("ref 尚未赋值（undefined）：返回 true（fail closed）", () => {
  const clients = new Map([["mic", {}]]);
  assert.equal(isStartCancelled(undefined, clients), true);
  assert.equal(isStartCancelled(null, clients), true);
});

test("内容相同但不同实例：返回 true（比的是身份不是内容）", () => {
  const a = new Map([["mic", {}], ["speaker", {}]]);
  const b = new Map([["mic", {}], ["speaker", {}]]);
  assert.deepEqual([...a.keys()], [...b.keys()]);
  assert.equal(isStartCancelled(b, a), true);
});

test("空 Map 与自身同一实例：返回 false", () => {
  const empty = new Map();
  assert.equal(isStartCancelled(empty, empty), false);
});

test("源码结构守卫：循环开头到 new FunASRClient() 之间有 abortIfCancelled()", () => {
  const loopAt = pageSource.indexOf("for (const deviceId of activeDevices) {");
  assert.notEqual(loopAt, -1, "找不到多路采集循环");
  const newClientAt = pageSource.indexOf("const client = new FunASRClient();", loopAt);
  assert.notEqual(newClientAt, -1, "找不到循环内 new FunASRClient()");
  const between = pageSource.slice(loopAt, newClientAt);
  assert.match(between, /abortIfCancelled\(\)/, "每轮开头必须检查取消（abortIfCancelled()）");
});

test("源码结构守卫：started.push(client) 之后紧接 if (abortIfCancelled()) return;", () => {
  const pushAt = pageSource.indexOf("started.push(client);");
  assert.notEqual(pushAt, -1, "找不到 started.push(client);");
  const after = pageSource.slice(pushAt);
  assert.match(
    after,
    /started\.push\(client\);\s*\n\s*if \(abortIfCancelled\(\)\) return;/,
    "await 返回后必须先把自己 push 进 started，再检查取消"
  );
});
