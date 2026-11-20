/**
 * LLM 队列的异步上下文隔离单测（issue #69，node --test）
 *
 * 背景：`llm-queue` 的任务闭包在**入队时**只是被塞进 `pending`，真正启动它的是
 * 「某个任务完成后的 .finally → pump()」。如果不把入队者的异步上下文一起存下来，
 * 排队期间别的请求触发了 pump，任务就会继承**那个请求**的 AsyncLocalStorage 身份。
 * 对本项目（身份挂在 ALS 上、属主校验读 `getCurrentActor()`）而言，等于把 A 的
 * 身份借给 B 的请求 —— `POST /api/meetings/<A的会议>/ai-title` 因此能改 A 的标题。
 *
 * 覆盖：
 *   C1 接上钩子后：并发槽占满时入队的任务，执行时看到的仍是**自己**的上下文；
 *   C2 变异验证：把钩子置空（= 修复前的行为），同一个用例必须**失败**，
 *      即「任务继承启动 pump 的请求的上下文」。C2 保证 C1 不是假绿。
 *
 * 运行：node --test scripts/llm-queue-context-test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const repoRoot = new URL("..", import.meta.url).pathname;

// `@/` 别名解析：让测试直接跑真实源码（Node 24 原生类型擦除）
registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith("@/")) {
      return next(pathToFileURL(join(repoRoot, "src", spec.slice(2))).href, context);
    }
    return next(spec, context);
  },
});

const queueModule = await import(pathToFileURL(join(repoRoot, "src/lib/llm-queue.ts")).href);
const { llmQueue, setLlmQueueConfigReader, setLlmQueueContextHooks } = queueModule;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 唯一一个 ALS 实例：钩子绑定的和任务入队时用的必须是同一个。
const als = new AsyncLocalStorage();

/**
 * 复现「A 占满并发槽 → B 入队滞留 → A 完成时触发 pump」这一顺序，
 * 返回两个任务执行时各自看到的上下文。
 */
async function runTwoTenants() {
  setLlmQueueConfigReader(async () => ({ maxConcurrency: 1, capacity: 10 }));

  const seen = {};
  // A 在自己的上下文里入队，占满唯一并发槽
  const aPromise = als.run({ who: "A" }, () => llmQueue.enqueue("chat", async () => {
    await sleep(120);
    seen.A = als.getStore() ?? null;
    return "A";
  }));

  // B 在自己的上下文里入队 → 槽满，任务滞留 pending
  await sleep(20);
  const bPromise = als.run({ who: "B" }, () => llmQueue.enqueue("title", async () => {
    seen.B = als.getStore() ?? null;
    return "B";
  }));

  const [a, b] = await Promise.all([aPromise, bPromise]);
  return { a, b, seen };
}

test("C1 接上钩子：排队任务在自己的上下文里执行（issue #69 根治）", async () => {
  setLlmQueueContextHooks({
    capture: () => als.getStore() ?? null,
    run: async (context, task) => (context ? await als.run(context, task) : await task()),
  });

  const { a, b, seen } = await runTwoTenants();
  assert.equal(a, "A");
  assert.equal(b, "B");
  assert.deepEqual(seen.A, { who: "A" }, "A 的任务必须看到 A 的上下文");
  assert.deepEqual(seen.B, { who: "B" }, "B 的任务必须看到 B 的上下文，而不是启动 pump 的 A");
});

test("C2 变异验证：钩子置空（= 修复前）时，排队任务会继承启动 pump 的请求身份", async () => {
  setLlmQueueContextHooks(null);

  const { seen } = await runTwoTenants();
  // 这条断言刻意描述**错误行为**：它证明 C1 能区分「修好了」和「没修」。
  // 若哪天引擎/队列实现变化导致这条不再成立，说明 C1 失去了判据，需要重新设计。
  assert.deepEqual(
    seen.B,
    { who: "A" },
    "修复前 B 的任务应继承 A 的上下文；若不成立说明本测试已失去判据"
  );
});

test("C3 无 actor 的后台入队（capture 为 null）不得继承启动 pump 的请求身份", async () => {
  // 镜像 admin-store 注册的真实钩子语义：null 分支必须 exit，而不是裸跑。
  setLlmQueueConfigReader(async () => ({ maxConcurrency: 1, capacity: 10 }));
  setLlmQueueContextHooks({
    capture: () => als.getStore() ?? null,
    run: async (context, task) => (context ? await als.run(context, task) : await als.exit(task)),
  });

  let sawInBackgroundTask = "unset";
  // A 占满唯一并发槽
  const aPromise = als.run({ who: "A" }, () => llmQueue.enqueue("chat", async () => {
    await sleep(120);
    return "A";
  }));
  await sleep(20);
  // 后台任务在**没有任何上下文**的地方入队 → capture 返回 null
  const bgPromise = llmQueue.enqueue("title", async () => {
    sawInBackgroundTask = als.getStore() ?? null;
    return "BG";
  });

  const [a, bg] = await Promise.all([aPromise, bgPromise]);
  assert.equal(a, "A");
  assert.equal(bg, "BG");
  assert.equal(
    sawInBackgroundTask,
    null,
    "无 actor 的任务由 A 的 pump 启动时，必须看不到 A 的身份（fail closed），而不是借用它"
  );
});

test("C4 接线断言：admin-store 的 null 分支必须用 actorContext.exit（fail closed）", () => {
  // 这条是「接线守卫」而不是行为测试：C3 验的是队列契约，真正决定 fail-closed 的
  // 是 admin-store 里注册的那段钩子实现。用源码断言钉住它，避免有人把 exit 改回裸跑。
  const adminStoreSource = readFileSync(join(repoRoot, "src", "lib", "admin-store.ts"), "utf8");
  assert.match(
    adminStoreSource,
    /return await actorContext\.exit\(task\);/,
    "admin-store 的队列上下文钩子必须在无 actor 时走 actorContext.exit(task)"
  );
});
