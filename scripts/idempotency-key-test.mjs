/**
 * 保存幂等键生成的单测（issue #74-3，node --test）
 *
 * 直接跑**真实实现** `src/lib/idempotency-key.ts`（Node 22.18+ 原生类型擦除）。
 * 该模块零 import，所以用 `pathToFileURL` + 动态 import 即可，不需要 `@/` 解析钩子
 * （见同目录 unsaved-work-test.mjs 的直连 import 写法）。
 *
 * ⚠ 全部用例都**注入假 crypto**，不依赖运行环境的 `globalThis.crypto`：
 * 回归的本质就是「非安全上下文里 crypto.randomUUID 是 undefined」，
 * 用真实环境跑会让 Node（有 randomUUID）永远走第一分支、测不到降级路径。
 *
 * 运行：npm run test:idempotency-key
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;

const { newIdempotencyKey } = await import(
  pathToFileURL(join(repoRoot, "src/lib", "idempotency-key.ts")).href
);

/** 假 crypto：只提供 getRandomValues（模拟非安全上下文），用 LCG 填字节，保证每次调用产出不同。 */
function fakeRandomValuesOnly() {
  let seed = 0x2f6e2b1 >>> 0;
  return {
    _calls: [],
    getRandomValues(array) {
      this._calls.push(array);
      for (let i = 0; i < array.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        array[i] = seed & 0xff;
      }
      return array;
    },
  };
}

test("提供 randomUUID 时直接返回它的值", () => {
  const fake = { randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
  assert.equal(newIdempotencyKey(fake), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("只有 getRandomValues（模拟非安全上下文）→ 32 位小写十六进制，且两次不同", () => {
  const fake = fakeRandomValuesOnly();
  const a = newIdempotencyKey(fake);
  const b = newIdempotencyKey(fake);
  assert.match(a, /^[0-9a-f]{32}$/, `应为 32 位小写十六进制，实际：${a}`);
  assert.match(b, /^[0-9a-f]{32}$/, `应为 32 位小写十六进制，实际：${b}`);
  assert.notEqual(a, b, "两次调用应不同");
});

test("传入 undefined → 走最后兜底，非空且两次不同", () => {
  const a = newIdempotencyKey(undefined);
  const b = newIdempotencyKey(undefined);
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0, "兜底结果应为非空字符串");
  assert.notEqual(a, b, "两次兜底结果应不同");
});

test("getRandomValues 收到的是长度 16 的 Uint8Array", () => {
  const fake = fakeRandomValuesOnly();
  newIdempotencyKey(fake);
  assert.equal(fake._calls.length, 1, "应恰好调用一次 getRandomValues");
  const arg = fake._calls[0];
  assert.ok(arg instanceof Uint8Array, "参数应为 Uint8Array");
  assert.equal(arg.length, 16, "长度应为 16");
});

test("三条路径的返回值都不含空白字符", () => {
  const withUuid = newIdempotencyKey({ randomUUID: () => "abc-123" });
  const withRandom = newIdempotencyKey(fakeRandomValuesOnly());
  const fallback = newIdempotencyKey(undefined);
  for (const value of [withUuid, withRandom, fallback]) {
    assert.doesNotMatch(value, /\s/, `不应含空白字符，实际：${JSON.stringify(value)}`);
  }
});
