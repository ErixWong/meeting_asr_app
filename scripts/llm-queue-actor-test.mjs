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
 * 占满队列的并发槽：默认 maxConcurrency=2，塞 2 个会 sleep 的任务。
 * 默认用**另一个用户 B** 占槽 —— 这样后续 A 的任务若继承 pump 身份，就会看到 B，
 * 断言才有区分力（用 A 占槽时，无论修没修都会看到 A，测试就白测了）。
 */
async function occupyQueueSlots(actor = actorB) {
  const holders = [];
  for (let i = 0; i < 2; i += 1) {
    holders.push(store.runWithActor(actor, () => llmQueue.enqueue("chat", async () => {
      await sleep(150);
      return `holder-${i}`;
    })));
  }
  // 等它们真正开始跑（进入 inFlight）
  await sleep(30);
  return Promise.all(holders);
}

test("A1 真实接线：有 actor 入队的任务，执行时拿到的是入队者而不是启动 pump 的人", async () => {
  // 关键：用 B 占槽。修复前 A 的任务会由 B 的 .finally → pump 启动，从而看到 B。
  const holders = occupyQueueSlots(actorB);
  await sleep(10);

  let seenInTask = "unset";
  const queued = store.runWithActor(actorA, () => llmQueue.enqueue("title", async () => {
    seenInTask = store.getCurrentActor().id;
    return "ok";
  }));

  await Promise.all([holders, queued]);
  assert.equal(seenInTask, "user-A", "任务必须看到入队者 A 的身份，而不是启动 pump 的 B");
});

test("A2 真实接线：无 actor 入队的后台任务，由 A 的 pump 启动时 getCurrentActor() 必须抛错", async () => {
  const holders = occupyQueueSlots();
  await sleep(10);

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

  await Promise.all([holders, queued]);
  assert.match(
    outcome,
    /^threw:/,
    `后台任务不得继承启动 pump 的 A 身份（fail closed）；实际: ${outcome}`
  );
});
