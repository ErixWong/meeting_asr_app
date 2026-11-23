/**
 * 保存重试的幂等键行为测试（fix-261123-04，issue #74-3）
 *
 * 真实 sqlite 沙箱（照抄 scripts/llm-queue-actor-test.mjs 的头部：
 * mkdtempSync + SQLITE_PATH + registerHooks 解析 @/ + createKnexInstance/initializeSchema 建库）。
 * 本测试**不触发 LLM 队列**（createMeeting / appendMeetingTranscript 都不入队；入队发生在路由里），
 * 所以 teardown 直接 closeDb() 即可，不需要 whenQuiescent 屏障。
 *
 * 覆盖：
 *   1. 同一个 idempotencyKey 连续 createMeeting 两次 → 第二次返回同一个 meeting id，
 *      且 meetings 表只有 1 行（证明去重生效，不是「服务端已提交但响应丢失→重复建会议」）。
 *   2. 不同的 key 两次 → 两条不同会议（证明没有误去重）。
 *   3. 不带 key 两次 → 两条不同会议（向后兼容）。
 *   4. 同一个 key 连续 appendMeetingTranscript 两次 → meeting_asr_results 行数不增加
 *      （段不重复追加）。
 *   5. 迁移后 idempotency_keys 表存在，且 SCHEMA_VERSION 变成 6。
 *
 * 运行：npm run test:idempotency
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;
const sandbox = mkdtempSync(join(tmpdir(), "idempotency-test-"));
process.chdir(sandbox);

const { closeDb, getDb } = await import("../server/db-shared.mjs");
after(async () => {
  // 本测试不入队，无 fire-and-forget 的队列刷新会在 teardown 后重开库，
  // 直接关连接池即可（区别于 llm-queue-actor-test 的 whenQuiescent 屏障）。
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
process.env.DB_TYPE = "sqlite";
process.env.SQLITE_PATH = join(dataDir, "meeting-asr-app.db");

const { AsyncDb } = await import("../server/db/async-db.mjs");
const { createKnexInstance } = await import("../server/db/index.mjs");
const { initializeSchema, SCHEMA_VERSION, MIGRATIONS } = await import("../server/db/schema.mjs");
{
  const bootstrapKnex = createKnexInstance("sqlite");
  await initializeSchema(new AsyncDb(bootstrapKnex, "sqlite"));
  await bootstrapKnex.destroy();
}

// 真实模块：createMeeting / appendMeetingTranscript 直接跑真库
const store = await import(pathToFileURL(join(repoRoot, "src", "lib", "admin-store.ts")).href);

const actor = {
  id: "user-idem",
  accountName: "tester",
  displayName: "Tester",
  status: "active",
  email: null,
  mustChangePassword: false,
};

// meetings.created_by_user_id 外键引用 users.id，先插一行与 actor 同 id 的用户，
// 否则 createMeeting 的 INSERT INTO meetings 会 SQLITE_CONSTRAINT_FOREIGNKEY。
{
  const database = await getDb();
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO users (id, account_name, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(actor.id, actor.accountName, actor.displayName, actor.status, now, now);
}

/** 在 actor 上下文里跑（createMeeting 内部 getCurrentActor / writeAuditLog 需要 actor）。 */
function withActor(fn) {
  return store.runWithActor(actor, fn);
}

function meetingInput(overrides = {}) {
  return {
    title: "测试会议",
    sourceType: "live_recording",
    sourceFileName: null,
    durationSeconds: 12,
    captureSessionId: `capture-${Math.random().toString(16).slice(2)}`,
    captureSessionIds: [],
    transcriptSegments: [
      {
        id: `seg-${Math.random().toString(16).slice(2)}`,
        speaker: "spk-1",
        text: "这是会议内容",
        time: "00:00",
        timeSeconds: 0,
        isFinal: true,
      },
    ],
    ...overrides,
  };
}

/** 直接查库：某表的行数。 */
async function rowCount(table, where) {
  const database = await getDb();
  const sql = where
    ? `SELECT COUNT(*) AS c FROM ${table} WHERE ${where.sql}`
    : `SELECT COUNT(*) AS c FROM ${table}`;
  const params = where ? where.params : [];
  const row = await database.prepare(sql).get(...params);
  return Number(row?.c ?? 0);
}

test("用例1：同一个 idempotencyKey 连续 createMeeting 两次 → 返回同一 id，meetings 只 1 行", async () => {
  const key = "idem-create-same-key";
  const before = await withActor(() => rowCount("meetings"));

  const first = await withActor(() => store.createMeeting(meetingInput({ idempotencyKey: key })));
  assert.ok(first?.id, "第一次 createMeeting 必须返回会议");
  const afterFirst = await withActor(() => rowCount("meetings"));
  assert.equal(afterFirst, before + 1, "第一次应新增 1 条会议");

  // 同 key 重试：模拟「服务端已提交但响应丢失 → 用户点重试」
  const second = await withActor(() => store.createMeeting(meetingInput({ idempotencyKey: key })));
  assert.ok(second?.id, "第二次 createMeeting 必须返回会议");
  assert.equal(second.id, first.id, "同 key 必须返回同一个 meeting id");

  const afterSecond = await withActor(() => rowCount("meetings"));
  assert.equal(afterSecond, before + 1, `meetings 表必须只有 1 行新增，实际 +${afterSecond - before}`);
});

test("用例2：不同的 key 两次 → 两条不同会议（没有误去重）", async () => {
  const before = await withActor(() => rowCount("meetings"));
  const a = await withActor(() => store.createMeeting(meetingInput({ idempotencyKey: "idem-key-A" })));
  const b = await withActor(() => store.createMeeting(meetingInput({ idempotencyKey: "idem-key-B" })));
  assert.notEqual(a.id, b.id, "不同 key 必须是两条不同会议");
  const after = await withActor(() => rowCount("meetings"));
  assert.equal(after, before + 2, "不同 key 应新增 2 条会议");
});

test("用例3：不带 key 两次 → 两条不同会议（向后兼容）", async () => {
  const before = await withActor(() => rowCount("meetings"));
  const a = await withActor(() => store.createMeeting(meetingInput()));
  const b = await withActor(() => store.createMeeting(meetingInput()));
  assert.notEqual(a.id, b.id, "不带 key 必须是两条不同会议");
  const after = await withActor(() => rowCount("meetings"));
  assert.equal(after, before + 2, "不带 key 应新增 2 条会议");
});

test("用例4：同一个 key 连续 appendMeetingTranscript 两次 → meeting_asr_results 行数不增加", async () => {
  // 先建一个不带 key 的会议作为被追加对象
  const meeting = await withActor(() => store.createMeeting(meetingInput()));
  assert.ok(meeting?.id, "前置：必须先建出一个会议");

  const appendInput = (key) => ({
    meetingId: meeting.id,
    captureSessionId: `append-cap-${Math.random().toString(16).slice(2)}`,
    captureSessionIds: [],
    transcriptSegments: [
      {
        id: `seg-${Math.random().toString(16).slice(2)}`,
        speaker: "spk-1",
        text: "追加的一段转写",
        time: "00:01",
        timeSeconds: 1,
        isFinal: true,
      },
    ],
    idempotencyKey: key,
  });

  const rowsBefore = await withActor(() => rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meeting.id] }));

  const firstAppend = await withActor(() => store.appendMeetingTranscript(appendInput("idem-append-key")));
  assert.ok(firstAppend?.id === meeting.id, "第一次追加应返回同一会议");
  const rowsAfterFirst = await withActor(() => rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meeting.id] }));
  assert.equal(rowsAfterFirst, rowsBefore + 1, "第一次追加应新增 1 条转写结果");

  // 同 key 重试：不得重复追加
  const secondAppend = await withActor(() => store.appendMeetingTranscript(appendInput("idem-append-key")));
  assert.ok(secondAppend?.id === meeting.id, "第二次追加应返回同一会议");
  const rowsAfterSecond = await withActor(() => rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meeting.id] }));
  assert.equal(rowsAfterSecond, rowsAfterFirst, `同 key 重试不得再追加转写段，实际 ${rowsBefore}→${rowsAfterFirst}→${rowsAfterSecond}`);
});

test("用例5：迁移后 idempotency_keys 表存在，且 SCHEMA_VERSION 变成 6", async () => {
  // (a) 代码层：SCHEMA_VERSION 常量 = 6，且存在名为 idempotency-keys 的 v6 迁移
  assert.equal(SCHEMA_VERSION, 6, `SCHEMA_VERSION 应为 6，实际 ${SCHEMA_VERSION}`);
  const v6 = MIGRATIONS.find((m) => m.version === 6);
  assert.ok(v6, "MIGRATIONS 应包含 version:6 的迁移");
  assert.equal(v6?.name, "idempotency-keys", "v6 迁移名应为 idempotency-keys");

  // (b) 运行时库：schema_version 记账为单行 6
  const database = await getDb();
  const versionRows = await database.prepare("SELECT version FROM schema_version").all();
  assert.equal(versionRows.length, 1, `schema_version 应恰好 1 行，实际 ${versionRows.length} 行`);
  assert.equal(Number(versionRows[0].version), 6, `schema_version 应为 6，实际 ${versionRows[0].version}`);

  // (c) 表结构：idempotency_keys 表真实存在且有 4 个列
  const cols = await database.prepare("PRAGMA table_info(idempotency_keys)").all();
  const colNames = cols.map((c) => c.name).sort();
  assert.ok(cols.length > 0, "idempotency_keys 表应存在");
  assert.deepEqual(colNames, ["created_at", "key", "meeting_id", "scope"], `列应为 key/scope/meeting_id/created_at，实际 ${colNames}`);
});
