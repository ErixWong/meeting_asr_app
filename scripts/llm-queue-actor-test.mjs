/**
 * 队列上下文隔离的**真实接线**行为测试（issue #69，PR #71 验收 J2）
 *
 * 与 `scripts/llm-queue-context-test.mjs` 的分工：
 *   - 那个测的是**队列契约**（用测试自己写的钩子）：入队捕获 / 执行恢复 / null 走 exit；
 *   - 这个测的是**真实接线**：直接 import `admin-store.ts`，用它自己注册的钩子，
 *     断言真实 `getCurrentActor()` 的行为。
 *
 * 覆盖：
 *   A1 有 actor 入队：任务执行时 `getCurrentActor()` 拿到的是**入队者**，不是启动 pump 的人；
 *   A2 无 actor 入队（后台任务）：由 A 的 pump 启动时，`getCurrentActor()` 必须**抛错**
 *      （fail closed），而不是静默返回 A。
 *
 * 为什么必须有 A2：`llm-queue-context-test.mjs` 的 C4 只是「源码里有这行」的文本守卫，
 * 证明不了真实 `getCurrentActor()` 会抛错；只有这条能。
 *
 * 运行：npm run test:queue-actor
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;
const sandbox = mkdtempSync(join(tmpdir(), "queue-actor-test-"));
process.chdir(sandbox);

after(async () => {
  const { closeDb } = await import("../server/db-shared.mjs");
  await closeDb();
  rmSync(sandbox, { recursive: true, force: true });
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = join(repoRoot, "src", specifier.slice(2));
      for (const candidate of [`${base}.ts`, `${base}.tsx`, base, join(base, "index.ts")]) {
        if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
      }
    }
    return next(specifier, context);
  },
});

// 独立沙箱库：不碰仓库里的 data/
const dataDir = join(sandbox, "data");
mkdirSync(dataDir, { recursive: true });
process.env.SQLITE_PATH = join(dataDir, "meeting-asr-app.db");

const { AsyncDb } = await import("../server/db/async-db.mjs");
const { createKnexInstance } = await import("../server/db/index.mjs");
const { initializeSchema } = await import("../server/db/schema.mjs");
{
  const bootstrapKnex = createKnexInstance("sqlite");
  await initializeSchema(new AsyncDb(bootstrapKnex, "sqlite"));
  await bootstrapKnex.destroy();
}

// 真实模块：admin-store 在 import 时就注册了队列上下文钩子
const store = await import(pathToFileURL(join(repoRoot, "src", "lib", "admin-store.ts")).href);
const { llmQueue } = await import(pathToFileURL(join(repoRoot, "src", "lib", "llm-queue.ts")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 确定性屏障：等到队列真的把并发槽占满，而不是靠固定 sleep 猜。
 *
 * 为什么必须这样：`llmQueue.enqueue` 开头要 `await configReader()`（一次 DB 读），
 * 所以「sleep 30ms 之后槽一定满了」不成立。探针若在槽未满时入队，会直接以入队者的身份
 * 执行、根本不经过别人的 pump —— 那样 A1 会假绿（事后审计 A 项）。
 */
async function waitForInFlight(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = llmQueue.getStatus();
    if (status.inFlight >= expected) return status;
    if (Date.now() > deadline) {
      throw new Error(`队列未在 ${timeoutMs}ms 内达到 inFlight>=${expected}，当前 ${JSON.stringify(status)}`);
    }
    await sleep(5);
  }
}

/**
 * 等队列里出现排队项（`queued >= expected`）。
 *
 * 为什么需要它：探针的 `enqueue()` 自己开头也要 `await configReader()`（一次 DB 读），
 * 所以「调用 enqueue 之后它就已经在 pending」不成立。必须显式等到 queued 出现，
 * 才能证明探针真的走了排队路径、而不是被立刻执行（issue #79 验收 Z1）。
 */
async function waitForQueued(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = llmQueue.getStatus();
    if (status.queued >= expected) return status;
    if (Date.now() > deadline) {
      throw new Error(`队列未在 ${timeoutMs}ms 内出现 queued>=${expected}，当前 ${JSON.stringify(status)}`);
    }
    await sleep(5);
  }
}

const actorA = {
  id: "user-A",
  accountName: "alice",
  displayName: "Alice",
  status: "active",
  email: null,
  mustChangePassword: false,
};

const actorB = {
  id: "user-B",
  accountName: "bob",
  displayName: "Bob",
  status: "active",
  email: null,
  mustChangePassword: false,
};

/**
 * 占满并发槽，并让两个 holder **卡在闸门上**直到测试显式放行。
 *
 * 为什么用**另一个用户 B** 占槽：这样后续 A 的任务若继承 pump 身份就会看到 B，
 * 断言才有区分力（用 A 占槽时，无论修没修都会看到 A，测试就白测了）。
 *
 * 为什么不用 sleep(150)：靠时长猜「holder 还在跑」不可靠 —— 探针 enqueue 自身要读一次
 * 配置（DB 读），holder 可能在这段时间里结束，槽一空探针就会被立刻执行、不经过 pump，
 * A1 于是假绿（issue #79 验收 Z1）。闸门把这件事变成与时序无关的确定性行为。
 */
async function occupyQueueSlots(actor, gate) {
  const holders = [];
  for (let i = 0; i < 2; i += 1) {
    holders.push(store.runWithActor(actor, () => llmQueue.enqueue("chat", async () => {
      await gate;
      return `holder-${i}`;
    })));
  }
  await waitForInFlight(2);
  return Promise.all(holders);
}

test("A1 真实接线：有 actor 入队的任务，执行时拿到的是入队者而不是启动 pump 的人", async () => {
  // 用 B 占槽并卡住（闸门），保证探针入队期间槽一定不会空出来。
  let releaseHolders;
  const gate = new Promise((resolve) => { releaseHolders = resolve; });

  const holders = occupyQueueSlots(actorB, gate);
  await waitForInFlight(2);

  let seenInTask = "unset";
  const queued = store.runWithActor(actorA, () => llmQueue.enqueue("title", async () => {
    seenInTask = store.getCurrentActor().id;
    return "ok";
  }));

  try {
    // 关键断言：探针必须真的进了排队（否则它可能被立刻执行、根本不经过 pump → 假绿）。
    const queuedStatus = await waitForQueued(1);
    assert.ok(queuedStatus.inFlight >= 2, `探针排队时槽应仍被 holder 占满，实际 ${JSON.stringify(queuedStatus)}`);
  } finally {
    // 失败路径上也必须放行：否则 holder 永远卡在 await gate、队列停在 inFlight=2，
    // 会污染后续测试与 teardown（验收 W4）。
    releaseHolders();
  }

  await Promise.all([holders, queued]);
  assert.equal(seenInTask, "user-A", "任务必须看到入队者 A 的身份，而不是启动 pump 的 B");
});

test("A2 真实接线：无 actor 入队的后台任务，由**另一个 actor 的** pump 启动时 getCurrentActor() 必须抛错", async () => {
  let releaseHolders;
  const gate = new Promise((resolve) => { releaseHolders = resolve; });

  const holders = occupyQueueSlots(actorB, gate);
  await waitForInFlight(2);

  // 关键：在**任何 actor 上下文之外**入队 → capture() 返回 null
  let outcome = "unset";
  const queued = llmQueue.enqueue("title", async () => {
    try {
      outcome = `saw:${store.getCurrentActor().id}`;
    } catch (error) {
      outcome = `threw:${error instanceof Error ? error.message.slice(0, 40) : String(error)}`;
    }
    return "ok";
  });

  try {
    // 关键断言：探针必须真的进了排队（否则它可能被立刻执行、根本不经过 pump → 假绿）。
    await waitForQueued(1);
  } finally {
    // 失败路径上也必须放行：否则 holder 永远卡在 await gate、队列停在 inFlight=2，
    // 会污染后续测试与 teardown（验收 W4）。
    releaseHolders();
  }

  await Promise.all([holders, queued]);
  assert.match(
    outcome,
    /^threw:/,
    `后台任务不得继承启动 pump 的 A 身份（fail closed）；实际: ${outcome}`
  );
});
