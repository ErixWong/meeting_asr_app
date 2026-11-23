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
 *   6. 并发同 key createMeetingWithOutcome → meetings 恰好 +1（原子认领防双写）。
 *   7. key 绑定 scope / 目标会议：跨会议或跨作用域复用 → 抛 IdempotencyConflictError，目标会议转写不变。
 *   8. 业务写入失败 → 释放认领，同 key 可正常重试建会（不会卡在 in_progress）。
 *   9. createMeetingWithOutcome 首次 replayed=false，重放 replayed=true。
 *  10. 占位超 TTL → 回收重认领（变异守卫：删 TTL 重认领段应变红）。
 *  11. 源码结构守卫：route.ts 的 LLM 触发条件带 !outcome.replayed 前置（变异守卫）。
 *  12. 持有者令牌：旧令牌不得 release/complete 新持有者的行（验收 W2）。
 *  13. appendMeetingTranscriptWithOutcome 首次返回令牌且不在内部 complete；调用方 complete 后重放
 *      才为 replayed=true（验收 X2：complete 交给路由，覆盖全部副作用）。
 *  14. 源码结构守卫：[id]/route.ts 重放时立即 return。
 *  15. idempotency_keys 表有 claim_token 列。
 *  16. 令牌被他人回收 → 事务内 complete 命中 0 行 → createMeetingWithOutcome 抛 ConflictError 且
 *      不新增会议（验收 X1，变异守卫）。
 *  17. completeIdempotencyKey 返回布尔：令牌对→true、令牌错→false。
 *  18. 源码结构守卫：[id]/route.ts 的 completeIdempotencyKey 必须在 createMeetingLlmResult 之后
 *      （验收 X2，变异守卫）。
 *
 * 运行：npm run test:idempotency
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  // (c) 表结构：idempotency_keys 表真实存在且有 5 个列（fix-261123-04 W2 新增 claim_token）
  const cols = await database.prepare("PRAGMA table_info(idempotency_keys)").all();
  const colNames = cols.map((c) => c.name).sort();
  assert.ok(cols.length > 0, "idempotency_keys 表应存在");
  assert.deepEqual(
    colNames,
    ["claim_token", "created_at", "key", "meeting_id", "scope"],
    `列应为 key/scope/meeting_id/created_at/claim_token，实际 ${colNames}`
  );
});

test("用例6：并发同 key createMeetingWithOutcome → meetings 恰好 +1（原子认领防双写）", async () => {
  const key = "idem-concurrent-same-key";
  const before = await withActor(() => rowCount("meetings"));

  const runOne = async () => {
    try {
      const outcome = await withActor(() => store.createMeetingWithOutcome(meetingInput({ idempotencyKey: key })));
      return { ok: true, outcome };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const settled = await Promise.all([runOne(), runOne()]);
  // 核心不变量：两个并发请求只能造出 1 条会议（旧实现会双写）。
  const after = await withActor(() => rowCount("meetings"));
  assert.equal(after, before + 1, `并发同 key 必须只新增 1 条会议，实际 +${after - before}`);

  const successes = settled.filter((s) => s.ok);
  assert.ok(successes.length >= 1, "至少一方应成功建会/重放");
  for (const s of successes) {
    assert.equal(s.outcome.replayed, false, "成功返回会议的一方应是真正建会（replayed=false）");
    assert.ok(s.outcome.meeting?.id, "成功方应返回会议");
  }
  // 未成功的一方只能是因为“被并发方抢先”：抛 in_progress（或同 scope 冲突）。
  for (const s of settled) {
    if (!s.ok) {
      assert.ok(
        s.error instanceof store.IdempotencyInProgressError || s.error instanceof store.IdempotencyConflictError,
        `未成功的并发方应抛 IdempotencyInProgressError/ConflictError，实际 ${s.error}`
      );
    }
  }
});

test("用例7：key 绑定 scope/目标会议 → 跨会议或跨作用域复用抛 IdempotencyConflictError，目标会议转写不变", async () => {
  const meetingA = await withActor(() => store.createMeeting(meetingInput()));
  const meetingB = await withActor(() => store.createMeeting(meetingInput()));
  assert.ok(meetingA?.id && meetingB?.id, "前置：先建 A、B 两个会议");

  const appendInput = (meetingId, key) => ({
    meetingId,
    captureSessionId: `append-cap-${Math.random().toString(16).slice(2)}`,
    captureSessionIds: [],
    transcriptSegments: [
      { id: `seg-${Math.random().toString(16).slice(2)}`, speaker: "spk-1", text: "一段转写", time: "00:01", timeSeconds: 1, isFinal: true },
    ],
    idempotencyKey: key,
  });

  // (a) 目标会议绑定：key 先绑到 A 的追加，再用同一 key 追加到 B → meeting mismatch
  const boundKey = "idem-append-bound-A";
  const firstAppend = await withActor(() => store.appendMeetingTranscript(appendInput(meetingA.id, boundKey)));
  assert.equal(firstAppend?.id, meetingA.id, "A 的追加应命中 A 自己");

  const rowsBBefore = await withActor(() => rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meetingB.id] }));
  await assert.rejects(
    () => withActor(() => store.appendMeetingTranscript(appendInput(meetingB.id, boundKey))),
    (error) => error instanceof store.IdempotencyConflictError,
    "用 A 的 append key 追加 B 应抛 IdempotencyConflictError（meeting mismatch）"
  );
  const rowsBAfter = await withActor(() => rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meetingB.id] }));
  assert.equal(rowsBAfter, rowsBBefore, "冲突时 B 的转写不得被改动");

  // (b) 作用域绑定：meeting.create 作用域的 key 拿去 append → scope mismatch
  const createKey = "idem-scope-cross-key";
  const created = await withActor(() => store.createMeeting(meetingInput({ idempotencyKey: createKey })));
  assert.ok(created?.id, "前置：用 create key 建一个会议");
  await assert.rejects(
    () => withActor(() => store.appendMeetingTranscript(appendInput(created.id, createKey))),
    (error) => error instanceof store.IdempotencyConflictError,
    "用 meeting.create 的 key 去 append 应抛 IdempotencyConflictError（scope mismatch）"
  );
});

test("用例8：业务写入失败 → 释放认领，同 key 可正常重试建会", async () => {
  const key = "idem-release-key";
  // 空 title 触发 requireNonEmpty 抛错（在任何插入之前，因此不会留下方会议行）
  await assert.rejects(
    () => withActor(() => store.createMeetingWithOutcome(meetingInput({ idempotencyKey: key, title: "   " }))),
    "空 title 首次应抛错"
  );
  // claim 被释放（DELETE WHERE meeting_id=''），所以同 key 重试能成功建会，而不是卡在 in_progress
  const retry = await withActor(() => store.createMeetingWithOutcome(meetingInput({ idempotencyKey: key })));
  assert.ok(retry.meeting?.id, "释放后同 key 重试必须能建会");
  assert.equal(retry.replayed, false, "重试是真正新建（replayed=false），不是命中");
});

test("用例9：createMeetingWithOutcome 首次 replayed=false，重放 replayed=true（同 id）", async () => {
  const key = "idem-outcome-flag-key";
  const before = await withActor(() => rowCount("meetings"));
  const first = await withActor(() => store.createMeetingWithOutcome(meetingInput({ idempotencyKey: key })));
  assert.equal(first.replayed, false, "首次应为 false");
  assert.ok(first.meeting?.id, "首次应返回会议");
  const second = await withActor(() => store.createMeetingWithOutcome(meetingInput({ idempotencyKey: key })));
  assert.equal(second.replayed, true, "重放应为 true");
  assert.equal(second.meeting?.id, first.meeting.id, "重放应返回同一会议");
  const after = await withActor(() => rowCount("meetings"));
  assert.equal(after, before + 1, "两次调用只应有 1 条会议");
});

test("用例10：占位超过 TTL → 回收重认领（变异守卫：删掉 TTL 重认领段应变红）", async () => {
  const key = "idem-ttl-expired-key";
  // 手工插一条 20 分钟前的「进行中」占位（meeting_id 空串）
  const database = await getDb();
  const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await database
    .prepare(`INSERT INTO idempotency_keys ("key", scope, meeting_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(key, "meeting.create", "", staleAt);

  const before = await withActor(() => rowCount("meetings"));
  const outcome = await withActor(() => store.createMeetingWithOutcome(meetingInput({ idempotencyKey: key })));
  assert.equal(outcome.replayed, false, "过期占位应被回收重认领后正常建会（replayed=false）");
  assert.ok(outcome.meeting?.id, "应建出新会议");
  const after = await withActor(() => rowCount("meetings"));
  assert.equal(after, before + 1, "过期占位回收后应新增 1 条会议");
});

test("用例11：源码结构守卫 —— route.ts 的 LLM 触发条件必须带 !outcome.replayed 前置（变异守卫）", async () => {
  const { readFileSync } = await import("node:fs");
  const routePath = join(repoRoot, "src", "app", "api", "meetings", "route.ts");
  let src = readFileSync(routePath, "utf8");
  // 剥块注释与行注释，避免注释里的字面串造成假绿
  src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(
    src.includes("if (!outcome.replayed"),
    "createMeeting 路由的 LLM 触发条件必须以 `if (!outcome.replayed` 打头（重放不得再触发 LLM）"
  );
});

/** 剥掉块注释与行注释（照抄 scripts/unsaved-work-test.mjs 的 stripComments），避免注释里的字面串造成假绿。 */
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

function readRouteStripped(relPath) {
  return stripComments(readFileSync(relPath, "utf8"));
}

test("用例12：TTL 回收不误删/不误改新认领者（旧持有者令牌无法影响新行）", async () => {
  const key = "idem-ttl-not-cross-claim-key";
  const database = await getDb();
  const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  // 手工插一条 20 分钟前的占位（旧持有者，claim_token='old-token'，meeting_id 空串）
  await database
    .prepare(`INSERT INTO idempotency_keys ("key", scope, meeting_id, created_at, claim_token) VALUES (?, ?, ?, ?, ?)`)
    .run(key, "meeting.create", "", staleAt, "old-token");

  // A 认领：TTL 回收旧行后以**新 token** 重认领成功（返回 claimed + 新 token）。
  const claim = await withActor(() => store.claimIdempotencyKey(key, "meeting.create"));
  assert.equal(claim.status, "claimed", "过期占位应被 TTL 回收后重认领成功");
  const newToken = claim.token;
  assert.ok(newToken && newToken !== "old-token", "新认领者的 token 必须不同于旧 token");

  // 旧持有者拿自己的旧 token 试图影响：release / complete 都不应该命中新行。
  await withActor(() => store.releaseIdempotencyKey(key, "old-token"));
  await withActor(() => store.completeIdempotencyKey(key, "old-token", "meeting-x"));

  const row = await database
    .prepare(`SELECT claim_token, meeting_id FROM idempotency_keys WHERE "key" = ?`)
    .get(key);
  assert.ok(row, "旧持有者的 release/complete 不得删掉新认领者的行（行仍存在）");
  assert.notEqual(row.meeting_id, "meeting-x", "meeting_id 绝不能被旧 token 改成 meeting-x");
  assert.equal(row.meeting_id, "", "旧持有者的 complete 不得把 meeting_id 改掉（应仍为空串）");
  assert.equal(row.claim_token, newToken, "行的 claim_token 应仍是新认领者的 token");

  // 收尾：新持有者用自己的 token release，行应被正确删除（验证令牌确实能命中自己）。
  await withActor(() => store.releaseIdempotencyKey(key, newToken));
  const gone = await database.prepare(`SELECT 1 FROM idempotency_keys WHERE "key" = ?`).get(key);
  assert.ok(!gone, "新持有者用自己的 token release 应能删掉自己那一行");
});

test("用例13：appendMeetingTranscriptWithOutcome 首次返回令牌不内部 complete、调用方 complete 后第二次 replayed=true（X2）", async () => {
  const meeting = await withActor(() => store.createMeeting(meetingInput()));
  assert.ok(meeting?.id, "前置：先建一个会议");
  const rowsBefore = await withActor(() => rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meeting.id] }));

  const key = `idem-append-outcome-key-${Math.random().toString(16).slice(2)}`;
  const appendInput = () => ({
    meetingId: meeting.id,
    captureSessionId: `append-cap-${Math.random().toString(16).slice(2)}`,
    captureSessionIds: [],
    transcriptSegments: [
      { id: `seg-${Math.random().toString(16).slice(2)}`, speaker: "spk-1", text: "一段转写", time: "00:01", timeSeconds: 1, isFinal: true },
    ],
    idempotencyKey: key,
  });

  const first = await withActor(() => store.appendMeetingTranscriptWithOutcome(appendInput()));
  assert.equal(first.replayed, false, "首次追加应为 replayed=false");
  assert.equal(first.meeting?.id, meeting.id, "首次应返回同一会议");
  // X2：WithOutcome 不再内部 complete，首次必须把认领令牌透出给调用方。
  assert.equal(typeof first.claimToken, "string", "首次追加必须返回认领令牌（X2：complete 交给调用方）");
  assert.ok(first.claimToken && first.claimToken.length > 0, "claimToken 应为非空字符串");

  // 令牌未 complete 前，meeting_id 仍为空 ⇒ 第二次同 key 视为「进行中」（证明 WithOutcome 没内部 complete）。
  await assert.rejects(
    () => withActor(() => store.appendMeetingTranscriptWithOutcome(appendInput())),
    (error) => error instanceof store.IdempotencyInProgressError,
    "令牌未 complete 时第二次同 key 应抛 IdempotencyInProgressError"
  );

  // 模拟路由：所有副作用完成后才 complete（事务外、传 token）。
  const completed = await withActor(() => store.completeIdempotencyKey(key, first.claimToken, meeting.id));
  assert.equal(completed, true, "用正确令牌 complete 应返回 true");

  const third = await withActor(() => store.appendMeetingTranscriptWithOutcome(appendInput()));
  assert.equal(third.replayed, true, "complete 之后同 key 应为 replayed=true");
  assert.equal(third.meeting?.id, meeting.id, "重放应返回同一会议");
  assert.equal(third.claimToken, null, "重放时 claimToken 必须为 null");

  const rowsAfter = await withActor(() => rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meeting.id] }));
  assert.equal(rowsAfter, rowsBefore + 1, `重放不得重复追加，meeting_asr_results 应只 +1，实际 +${rowsAfter - rowsBefore}`);
});

test("用例14：源码结构守卫 —— PATCH 路由 [id]/route.ts 重放时必须立即 return（变异守卫）", async () => {
  const routePath = join(repoRoot, "src", "app", "api", "meetings", "[id]", "route.ts");
  const src = readRouteStripped(routePath);
  const guardAt = src.indexOf("if (appendOutcome.replayed)");
  assert.notEqual(guardAt, -1, "[id]/route.ts 必须存在 `if (appendOutcome.replayed)` 重放护栏");
  const window = src.slice(guardAt, guardAt + 400);
  assert.ok(
    window.includes("return NextResponse.json({ meeting });"),
    "重放护栏内必须紧跟 `return NextResponse.json({ meeting });`（重放不得再跑后续副作用）"
  );
});

test("用例15：idempotency_keys 表有 claim_token 列（持有者令牌）", async () => {
  const database = await getDb();
  const cols = await database.prepare("PRAGMA table_info(idempotency_keys)").all();
  const names = cols.map((c) => c.name);
  assert.ok(names.includes("claim_token"), `idempotency_keys 应含 claim_token 列，实际 ${names.join(",")}`);
});

test("用例16：令牌被他人回收后 complete 命中 0 行 → createMeetingWithOutcome 抛 ConflictError 且不新增会议（X1，变异守卫）", async () => {
  // 目标：在「createMeetingWithOutcome 已认领」与「它在事务内 complete」之间，把行里的 claim_token
  // 改成别的值（模拟 TTL 被他人回收/重认领），使事务内的 completeIdempotencyKey 命中 0 行、返回 false。
  // 此时 onCommitted 必须抛 IdempotencyConflictError ⇒ 整个事务回滚 ⇒ 不新增会议。
  // （删掉 `if (!ok) throw new IdempotencyConflictError(...)` 后本用例应变红：会议会被建出来、不报错。）
  const key = `idem-token-invalidated-${Math.random().toString(16).slice(2)}`;
  const before = await withActor(() => rowCount("meetings"));
  const database = await getDb();
  const input = meetingInput({ idempotencyKey: key });

  // 先启动 createMeetingWithOutcome：它先认领幂等键（插入占位行），随后在事务内 complete。
  const running = withActor(() => store.createMeetingWithOutcome(input));

  // 等认领写入的占位行出现（claim_token 已写入），立刻把 claim_token 改掉。
  // 轮询与 createMeetingWithOutcome 共用同一条 `_lockTail` 串行链（sqlite 单连接），故用纯串行
  // await 细粒度交错（不用 setTimeout：sqlite 同步驱动下 setTimeout(0) 会让整个事务在
  // 一个 tick 内跑完）。createMeetingUncached 在事务前有 listSettings 等多次串行读，本翻转会排在事务拿锁之前。
  let flipped = false;
  for (let i = 0; i < 200000 && !flipped; i++) {
    const row = await database.prepare(`SELECT claim_token FROM idempotency_keys WHERE "key" = ?`).get(key);
    if (row && row.claim_token) {
      await database
        .prepare(`UPDATE idempotency_keys SET claim_token = ? WHERE "key" = ?`)
        .run("reclaimed-by-another-worker", key);
      flipped = true;
    }
  }
  assert.ok(flipped, "前置：必须观测到认领写入的占位行才能模拟令牌失效");

  await assert.rejects(
    () => running,
    (error) => error instanceof store.IdempotencyConflictError,
    "令牌失效后 complete 命中 0 行，应在事务内抛 IdempotencyConflictError（删掉 `if (!ok) throw` 应变红）"
  );

  const after = await withActor(() => rowCount("meetings"));
  assert.equal(after, before, `complete 失败必须回滚事务、不新增会议，实际 +${after - before}（删 throw 会 +1）`);
});

test("用例17：completeIdempotencyKey 返回布尔（令牌对→true 并写 meeting_id，令牌错→false 且不改）", async () => {
  const key = `idem-complete-bool-${Math.random().toString(16).slice(2)}`;
  const database = await getDb();
  const now = new Date().toISOString();
  await database
    .prepare(`INSERT INTO idempotency_keys ("key", scope, meeting_id, created_at, claim_token) VALUES (?, ?, ?, ?, ?)`)
    .run(key, "meeting.create", "", now, "good-token");

  const wrong = await withActor(() => store.completeIdempotencyKey(key, "wrong-token", "meeting-wrong"));
  assert.equal(wrong, false, "令牌不匹配应返回 false");
  const midRow = await database.prepare(`SELECT meeting_id FROM idempotency_keys WHERE "key" = ?`).get(key);
  assert.equal(midRow.meeting_id, "", "令牌错的 complete 不应改 meeting_id（WHERE claim_token 不命中）");

  const ok = await withActor(() => store.completeIdempotencyKey(key, "good-token", "meeting-good"));
  assert.equal(ok, true, "令牌匹配应返回 true");
  const row = await database.prepare(`SELECT meeting_id FROM idempotency_keys WHERE "key" = ?`).get(key);
  assert.equal(row.meeting_id, "meeting-good", "令牌对的 complete 应把 meeting_id 写成目标会议");
});

test("用例18：源码结构守卫 —— PATCH 路由 [id]/route.ts 的 completeIdempotencyKey 必须在 createMeetingLlmResult 之后（变异守卫）", async () => {
  // 验收 X2：幂等键完成要覆盖全部副作用，所以 completeIdempotencyKey 必须排在 finalize 的
  // createMeetingLlmResult 之后。把 complete 那段挑到 finalize 之前，本守卫应变红。
  const routePath = join(repoRoot, "src", "app", "api", "meetings", "[id]", "route.ts");
  const src = readRouteStripped(routePath);
  // 用带开括号的调用形式避开 import 行（import 里是 `completeIdempotencyKey,` / `createMeetingLlmResult,`，无括号）。
  const llmAt = src.indexOf("createMeetingLlmResult(");
  const completeAt = src.indexOf("completeIdempotencyKey(");
  assert.notEqual(llmAt, -1, "PATCH 路由应触发 createMeetingLlmResult(");
  assert.notEqual(completeAt, -1, "PATCH 路由应在副作用之后调用 completeIdempotencyKey(");
  assert.ok(
    completeAt > llmAt,
    `completeIdempotencyKey( 必须排在 createMeetingLlmResult( 之后（幂等键完成要覆盖全部副作用）；complete=${completeAt}, llm=${llmAt}`
  );
});
