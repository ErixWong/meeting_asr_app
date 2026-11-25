/**
 * 保存路径「单事务 + 幂等键」测试（fix-261125-01，issue #74 最后一项）
 *
 * 真实 sqlite 沙箱（照抄 scripts/idempotency-test.mjs 的头部：
 * mkdtempSync + SQLITE_PATH + registerHooks 解析 @/ + createKnexInstance/initializeSchema 建库）。
 *
 * 覆盖：
 *   1. 同 key 连续 finalizeMeetingSave（带 append）两次 → 转写段不重复、meetings 行数不变、
 *      第二次 replayed=true（本单主验收：PATCH 重试不再重复追加转写）。
 *   2. 同 key 带 title/status 两次 → 第二次 replayed=true，标题/状态没有被二次改写
 *      （用 audit_logs 里 meeting.update / meeting.status.update 的条数证明第二次什么都没写）。
 *   3. 不带 key 两次 → 两次都真的执行（replayed=false、段数翻倍）——证明幂等是**显式开启**的。
 *   4. 事务内 completeIdempotencyKey 返回 false（令牌被他人换掉）→ 抛 IdempotencyConflictError
 *      且**转写没被追加**（事务回滚）。
 *      变异守卫：把 completeIdempotencyKey 挪到 withTransaction **外面** → 本用例转红。
 *   5. ensureMeetingLlmResult 连续两次 → 第二次 triggered=false。
 *      变异守卫：删掉存在性检查 → 本用例转红。
 *   6. 会议不存在 → { meeting: null }（带 key 与不带 key；带 key 时 key 不能被完成到空会议上）。
 *   7. 同 key 有未完成占位 → 抛 IdempotencyInProgressError，且不写任何副作用。
 *   8. 同一 key 用在别的 scope → 抛 IdempotencyConflictError。
 *   9. 源码结构守卫：PATCH 路由确实换成 finalizeMeetingSave / ensureMeetingLlmResult / 409 映射，
 *      page.tsx 的 PATCH headers 重新带上 "Idempotency-Key"。
 *  10. 同一个 key 用到别的会议上 → 抛 IdempotencyConflictError，且 B 一行没被改、A 也不变
 *      （一审判 V3：不绑会议的幂等重放会把 A 的会议返回给 B）。
 *      变异守卫：删掉 `claim.meetingId !== input.meetingId` 的抛错 → 本用例转红。
 *  11. 只有一条 translation 成功结果时 ensureMeetingLlmResult 仍必须 triggered=true
 *      （一审判 V4：翻译结果不能当成「纪要已生成」而跳过默认纪要）。
 *      变异守卫：去掉 `item.resultType !== "translation"` → 本用例转红。
 *  12. 存在性优先：PATCH 里 getMeetingById(id) 的 404 分支必须排在 body.status 参数校验之前
 *      （一审判 V5：不存在的会议 + 非法参数必须是 404，不是 400；路由层用源码结构守卫）。
 *
 * 运行：npm run test:meeting-save
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;
const sandbox = mkdtempSync(join(tmpdir(), "meeting-save-test-"));
process.chdir(sandbox);

const { closeDb, getDb } = await import("../server/db-shared.mjs");

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
const { initializeSchema } = await import("../server/db/schema.mjs");
{
  const bootstrapKnex = createKnexInstance("sqlite");
  await initializeSchema(new AsyncDb(bootstrapKnex, "sqlite"));
  await bootstrapKnex.destroy();
}

const store = await import(pathToFileURL(join(repoRoot, "src", "lib", "admin-store.ts")).href);
const runtimeStore = await import(pathToFileURL(join(repoRoot, "server", "runtime-store.mjs")).href);
const { llmQueue } = await import(pathToFileURL(join(repoRoot, "src", "lib", "llm-queue.ts")).href);

// 用例5 会真的 fire-and-forget 入队 LLM 生成（createMeetingLlmResultInner 走真实 llmRequest，
// 不吃 setLlmTransport —— 只有标题生成那条路径才走 llmTransport），所以这里起一个本地
// OpenAI 兼容桩服务，把 llm.base_url 指过去：不联网、可重复、走的是真实链路。
const llmStub = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: `桩纪要正文（收到 ${raw.length} 字节请求体）` }, finish_reason: "stop" },
        ],
      })
    );
  });
});
await new Promise((resolve) => llmStub.listen(0, "127.0.0.1", resolve));
const llmStubPort = llmStub.address().port;

after(async () => {
  // 先等队列静默再关库：否则关闭后仍有队列任务重开连接（照抄 llm-queue-actor-test 的屏障）。
  await llmQueue.whenQuiescent().catch(() => {});
  await closeDb();
  llmStub.close();
  rmSync(sandbox, { recursive: true, force: true });
});

const actor = {
  id: "user-meeting-save",
  accountName: "tester",
  displayName: "Tester",
  status: "active",
  email: null,
  mustChangePassword: false,
};

// meetings.created_by_user_id 外键引用 users.id：先插一行与 actor 同 id 的用户。
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

/** 在 actor 上下文里跑（finalizeMeetingSave 内部 getCurrentActor / writeAuditLog 需要 actor）。 */
function withActor(fn) {
  return store.runWithActor(actor, fn);
}

/** 某表行数（可选 WHERE）。 */
async function rowCount(table, where) {
  const database = await getDb();
  const sql = where
    ? `SELECT COUNT(*) AS c FROM ${table} WHERE ${where.sql}`
    : `SELECT COUNT(*) AS c FROM ${table}`;
  const params = where ? where.params : [];
  const row = await database.prepare(sql).get(...params);
  return Number(row?.c ?? 0);
}

const asrRowCount = (meetingId) =>
  rowCount("meeting_asr_results", { sql: "meeting_id = ?", params: [meetingId] });

const llmResultCount = (meetingId) =>
  rowCount("meeting_llm_results", { sql: "meeting_id = ?", params: [meetingId] });

/** 会议当前的转写段（transcript 由各条 meeting_asr_results 合并而来）。 */
async function transcriptOf(meetingId) {
  const meeting = await withActor(() => store.getMeetingById(meetingId));
  return meeting?.transcript ?? [];
}

/** 该会议的审计条数（用来证明「重放那一次什么都没写」）。 */
const auditCount = (meetingId, actionType) =>
  rowCount("audit_logs", { sql: "resource_id = ? AND action_type = ?", params: [meetingId, actionType] });

let meetingSeq = 0;

function segment(text) {
  return {
    id: `seg-${Math.random().toString(16).slice(2)}`,
    speaker: "spk-1",
    text,
    time: "00:00",
    timeSeconds: 0,
    isFinal: true,
  };
}

/**
 * 真建一条会议（status = transcribed、正文 1 段）。
 * ⚠ 建会本身就会写 1 段转写 + 1 行 meeting_asr_results，所以断言一律用 baseline 相减。
 */
async function newMeeting() {
  meetingSeq += 1;
  const meeting = await withActor(() =>
    store.createMeeting({
      title: `保存测试 ${meetingSeq}`,
      sourceType: "live_recording",
      sourceFileName: null,
      durationSeconds: 12,
      captureSessionId: `capture-seed-${meetingSeq}`,
      captureSessionIds: [],
      transcriptSegments: [segment(`建会时的正文 ${meetingSeq}`)],
    })
  );
  assert.ok(meeting?.id, "前置：建会必须成功");
  return meeting;
}

/** 建一个真有「待落盘事件」的 capture session：让保存路径的 flush 真的跑一次事务。 */
async function newCaptureSessionWithPendingEvents(captureSessionId) {
  await runtimeStore.createCaptureSession({
    captureSessionId,
    taskId: `task-${captureSessionId}`,
    asrProvider: "local_funasr",
    asrConfigSnapshot: { providerType: "local_funasr", endpoint: "ws://127.0.0.1:1" },
    hotwords: {},
  });
  const appended = await runtimeStore.appendCaptureEvent(captureSessionId, {
    payload: { mode: "2pass-offline", text: "事件正文" },
  });
  assert.equal(appended, true, "前置：capture 事件必须入队（保存时的 flush 才会真的跑）");
}

// ---------------------------------------------------------------------------
// 1. 主验收：同 key 重试不重复追加
// ---------------------------------------------------------------------------

test("用例1：同 key 连续 finalizeMeetingSave（带 append）两次 → 段不重复、meetings 不新增、第二次 replayed=true", async () => {
  const meeting = await newMeeting();
  const key = `save-append-same-key-${meeting.id}`;
  const segments = [segment("重试也不会重复的甲段"), segment("重试也不会重复的乙段")];

  const baseSegments = (await transcriptOf(meeting.id)).length;
  const baseAsrRows = await asrRowCount(meeting.id);
  const meetingsBefore = await rowCount("meetings");

  const first = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: meeting.id,
      appendTranscriptSegments: segments,
      captureSessionId: "capture-save-1",
      idempotencyKey: key,
    })
  );
  assert.equal(first.replayed, false, "首次必须是真的执行（replayed=false）");
  assert.ok(first.meeting, "首次必须返回会议");
  assert.equal(first.meeting.id, meeting.id);
  assert.equal(
    (await transcriptOf(meeting.id)).length,
    baseSegments + 2,
    "首次必须把 2 段追加进去"
  );
  assert.equal(await asrRowCount(meeting.id), baseAsrRows + 1, "首次应写入 1 行 meeting_asr_results");

  // 同 key 重试：模拟「服务端已提交但响应丢了 → 用户点重试」
  const second = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: meeting.id,
      appendTranscriptSegments: segments,
      captureSessionId: "capture-save-1",
      idempotencyKey: key,
    })
  );
  assert.equal(second.replayed, true, "同 key 第二次必须 replayed=true");
  assert.ok(second.meeting, "重放也要返回会议（路由据此不会误报 404）");
  assert.equal(second.meeting.id, meeting.id);

  assert.equal(
    (await transcriptOf(meeting.id)).length,
    baseSegments + 2,
    "转写段不得重复：重放后段数必须与首次之后完全一致"
  );
  assert.equal(await asrRowCount(meeting.id), baseAsrRows + 1, "重放不得再写 meeting_asr_results");
  assert.equal(await rowCount("meetings"), meetingsBefore, "追加与重放都不该新增 meetings 行");
});

// ---------------------------------------------------------------------------
// 2. 标题 / 状态也被同一个 key 覆盖
// ---------------------------------------------------------------------------

test("用例2：同 key 带 title/status 两次 → 第二次 replayed=true，标题与状态没有被二次改写", async () => {
  const meeting = await newMeeting(); // status = transcribed
  const key = `save-title-status-key-${meeting.id}`;

  const first = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: meeting.id,
      title: "第一次改的标题",
      status: "paused",
      lastErrorMessage: null,
      idempotencyKey: key,
    })
  );
  assert.equal(first.replayed, false);
  assert.equal(first.meeting?.title, "第一次改的标题", "首次标题必须写进去");
  assert.equal(first.meeting?.status, "paused", "首次状态必须迁移到 paused");
  assert.equal(await auditCount(meeting.id, "meeting.update"), 1, "首次应留下 1 条 meeting.update 审计");
  assert.equal(await auditCount(meeting.id, "meeting.status.update"), 1, "首次应留下 1 条 meeting.status.update 审计");

  const second = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: meeting.id,
      title: "重试带来的第二个标题",
      status: "paused",
      lastErrorMessage: null,
      idempotencyKey: key,
    })
  );
  assert.equal(second.replayed, true, "同 key 第二次必须 replayed=true");
  assert.equal(second.meeting?.title, "第一次改的标题", "重放返回的会议标题必须还是第一次那个");

  const after = await withActor(() => store.getMeetingById(meeting.id));
  assert.equal(after?.title, "第一次改的标题", "重放不得二次改写标题（直接读库再确认一次）");
  assert.equal(after?.status, "paused");
  assert.equal(await auditCount(meeting.id, "meeting.update"), 1, "重放不得再写 meeting.update");
  assert.equal(await auditCount(meeting.id, "meeting.status.update"), 1, "重放不得再写 meeting.status.update");
});

// ---------------------------------------------------------------------------
// 3. 幂等是显式开启的
// ---------------------------------------------------------------------------

test("用例3：不带 key 两次 → 两次都真的执行（replayed=false、段数翻倍）", async () => {
  const meeting = await newMeeting();
  const segments = [segment("无键保存的甲段"), segment("无键保存的乙段")];
  const baseSegments = (await transcriptOf(meeting.id)).length;
  const baseAsrRows = await asrRowCount(meeting.id);

  const first = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: meeting.id,
      appendTranscriptSegments: segments,
      captureSessionId: "capture-nokey-1",
    })
  );
  assert.equal(first.replayed, false);
  assert.equal((await transcriptOf(meeting.id)).length, baseSegments + 2, "首次追加 2 段");

  const second = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: meeting.id,
      appendTranscriptSegments: segments,
      captureSessionId: "capture-nokey-2",
    })
  );
  assert.equal(second.replayed, false, "不带 key 时第二次也必须 replayed=false（幂等必须显式开启）");
  assert.equal(
    (await transcriptOf(meeting.id)).length,
    baseSegments + 4,
    "不带 key 两次必须真的追加两次（段数在基线上再加 2）"
  );
  assert.equal(await asrRowCount(meeting.id), baseAsrRows + 2, "不带 key 两次必须写 2 行 meeting_asr_results");
});

// ---------------------------------------------------------------------------
// 4. 令牌失效 → 事务回滚（变异守卫：complete 挪到事务外应变红）
// ---------------------------------------------------------------------------

test("用例4：事务内 completeIdempotencyKey 命中 0 行 → 抛 ConflictError 且转写没被追加（事务回滚）", async () => {
  // 目标：在「已认领」与「事务内 complete」之间把行的 claim_token 改掉（模拟 TTL 被他人回收后重认领），
  // 使事务内的 completeIdempotencyKey 命中 0 行、返回 false ⇒ finalizeMeetingSave 必须抛
  // IdempotencyConflictError，且整笔写入回滚（转写一行都没写）。
  // 变异守卫：把 completeIdempotencyKey 挪到 withTransaction **之外** ⇒ 事务先提交、转写已落库，
  // 下面「meeting_asr_results 一行都没写」的断言就会变红。
  // 窗口：保存路径在认领之后、开事务之前会 flush 该 capture session 的待落盘事件（一个真事务），
  // 翻转就排在这段串行链里；翻转与事务的先后仍是竞速，所以用有限次重试直到观测到冲突。
  const database = await getDb();
  let conflicted = null;

  for (let attempt = 0; attempt < 40 && !conflicted; attempt += 1) {
    const meeting = await newMeeting();
    const key = `save-token-flipped-${attempt}-${Math.random().toString(16).slice(2)}`;
    const captureSessionId = `capture-flip-${attempt}`;
    await newCaptureSessionWithPendingEvents(captureSessionId);
    const asrBefore = await asrRowCount(meeting.id);
    const segmentsBefore = (await transcriptOf(meeting.id)).length;

    const running = withActor(() =>
      store.finalizeMeetingSave({
        meetingId: meeting.id,
        appendTranscriptSegments: [segment(`令牌翻转段 ${attempt}`)],
        captureSessionId,
        idempotencyKey: key,
      })
    );

    let flipped = false;
    for (let i = 0; i < 20000 && !flipped; i += 1) {
      try {
        const row = await database.prepare(`SELECT claim_token FROM idempotency_keys WHERE "key" = ?`).get(key);
        if (row?.claim_token) {
          await database
            .prepare(`UPDATE idempotency_keys SET claim_token = ? WHERE "key" = ?`)
            .run("reclaimed-by-another-worker", key);
          flipped = true;
        }
      } catch {
        // 事务持锁时可能 BUSY：继续轮询，下一轮再试。
      }
    }
    assert.ok(flipped, "前置：必须观测到认领写入的占位行，否则无法模拟令牌失效");

    try {
      await running;
      // 这一轮翻转来得太晚（事务已提交）：换一条会议重来。
    } catch (error) {
      assert.ok(
        error instanceof store.IdempotencyConflictError,
        `事务内 complete 命中 0 行必须抛 IdempotencyConflictError，实际 ${error?.constructor?.name}: ${error?.message}`
      );
      conflicted = { meetingId: meeting.id, asrBefore, segmentsBefore, key };
    }
  }

  assert.ok(conflicted, "40 次尝试内至少要观测到一次「事务内 complete 失败」，否则本用例没有验证到回滚");
  assert.equal(
    await asrRowCount(conflicted.meetingId),
    conflicted.asrBefore,
    "事务必须整体回滚：meeting_asr_results 一行都没多（把 complete 挪到事务外应变红）"
  );
  assert.equal(
    (await transcriptOf(conflicted.meetingId)).length,
    conflicted.segmentsBefore,
    "事务必须整体回滚：转写段数必须停在保存之前"
  );
  const keyRow = await database
    .prepare(`SELECT meeting_id FROM idempotency_keys WHERE "key" = ?`)
    .get(conflicted.key);
  assert.ok(
    !keyRow || String(keyRow.meeting_id ?? "") === "",
    "失败后不能把幂等键完成到这个会议上（必须 release，或至少仍是未完成占位）"
  );
});

// ---------------------------------------------------------------------------
// 5. LLM 触发可重放
// ---------------------------------------------------------------------------

test("用例5：ensureMeetingLlmResult 连续两次 → 第二次 triggered=false（不重复生成）", async () => {
  const meeting = await newMeeting();

  // 把 llm.base_url 指向本地桩服务（createMeetingLlmResultInner 拼的是 `${base_url}/chat/completions`）。
  const database = await getDb();
  await database
    .prepare(`UPDATE app_settings SET item_value = ? WHERE item_section = ? AND item_mark = ?`)
    .run(`http://127.0.0.1:${llmStubPort}/v1`, "llm", "base_url");

  const first = await withActor(() => store.ensureMeetingLlmResult(meeting.id));
  assert.equal(first.triggered, true, "没有任何结果时必须触发一次生成");

  // fire-and-forget：等队列把这一次跑完（用屏障，不猜时长）。
  for (let i = 0; i < 200 && (await llmResultCount(meeting.id)) === 0; i += 1) {
    await llmQueue.whenQuiescent();
  }
  assert.equal(await llmResultCount(meeting.id), 1, "前置：桩生成必须真的写入 1 行 meeting_llm_results");

  const second = await withActor(() => store.ensureMeetingLlmResult(meeting.id));
  assert.equal(second.triggered, false, "已有一份可用结果时必须跳过（删掉存在性检查应变红）");

  await llmQueue.whenQuiescent();
  assert.equal(await llmResultCount(meeting.id), 1, "第二次不得再生成第二行");
});

// ---------------------------------------------------------------------------
// 6. 会议不存在
// ---------------------------------------------------------------------------

test("用例6：会议不存在 → { meeting: null }（不带 key 与带 key 都是；带 key 时 key 不能被完成到空会议上）", async () => {
  const missing = `meeting-not-exist-${Math.random().toString(16).slice(2)}`;

  const keyless = await withActor(() => store.finalizeMeetingSave({ meetingId: missing }));
  assert.equal(keyless.meeting, null, "会议不存在必须返回 null（与 appendMeetingTranscript 的 null 语义一致）");
  assert.equal(keyless.replayed, false);

  const key = `save-missing-meeting-key-${Math.random().toString(16).slice(2)}`;
  const withKey = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: missing,
      appendTranscriptSegments: [segment("会议不存在时的正文")],
      title: "不该被写入的标题",
      idempotencyKey: key,
    })
  );
  assert.equal(withKey.meeting, null, "带 key 时会议不存在同样返回 null");
  assert.equal(withKey.replayed, false);

  const database = await getDb();
  const keyRow = await database.prepare(`SELECT meeting_id FROM idempotency_keys WHERE "key" = ?`).get(key);
  assert.ok(
    !keyRow || String(keyRow.meeting_id ?? "") === "",
    "会议不存在时不能把幂等键完成到不存在的会议上（必须 release 或保持未完成占位）"
  );
});

// ---------------------------------------------------------------------------
// 7/8. 认领失败的两条分支（路由据此映射 409）
// ---------------------------------------------------------------------------

test("用例7：同 key 已有未完成的占位 → 抛 IdempotencyInProgressError，且不写任何副作用", async () => {
  const meeting = await newMeeting();
  const key = `save-in-progress-${meeting.id}`;
  const database = await getDb();
  await database
    .prepare(`INSERT INTO idempotency_keys ("key", scope, meeting_id, created_at, claim_token) VALUES (?, ?, ?, ?, ?)`)
    .run(key, "meeting.save", "", new Date().toISOString(), "holder-of-the-key");

  await assert.rejects(
    () =>
      withActor(() =>
        store.finalizeMeetingSave({ meetingId: meeting.id, title: "不该写进去", idempotencyKey: key })
      ),
    (error) => error instanceof store.IdempotencyInProgressError,
    "占位未完成必须抛 IdempotencyInProgressError（路由映射 409）"
  );
  const after = await withActor(() => store.getMeetingById(meeting.id));
  assert.notEqual(after?.title, "不该写进去", "进行中时不得写入任何副作用");
  assert.equal(
    await rowCount("idempotency_keys", { sql: "\"key\" = ? AND claim_token = ?", params: [key, "holder-of-the-key"] }),
    1,
    "release 只能删自己那一行：别人的占位不能被误删"
  );
});

test("用例8：同一 key 用在别的 scope 上 → 抛 IdempotencyConflictError", async () => {
  const meeting = await newMeeting();
  const key = `save-scope-conflict-${meeting.id}`;
  await withActor(() => store.claimIdempotencyKey(key, "meeting.create"));

  await assert.rejects(
    () =>
      withActor(() =>
        store.finalizeMeetingSave({ meetingId: meeting.id, title: "不该写进去", idempotencyKey: key })
      ),
    (error) => error instanceof store.IdempotencyConflictError,
    "跨作用域复用同一 key 必须抛 IdempotencyConflictError（路由映射 409）"
  );
  const after = await withActor(() => store.getMeetingById(meeting.id));
  assert.notEqual(after?.title, "不该写进去", "scope 冲突时不得写入任何副作用");
});

// ---------------------------------------------------------------------------
// 9. 源码结构守卫：路由与前端确实接上了新函数/新键
// ---------------------------------------------------------------------------

/** 剥掉块注释与行注释（照抄 scripts/idempotency-test.mjs 的 stripComments），避免注释里的字面串造成假绿。 */
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

test("用例9：PATCH 路由改用 finalizeMeetingSave + ensureMeetingLlmResult + 409 映射；page.tsx 的 PATCH 重新带幂等键", () => {
  const route = stripComments(
    readFileSync(join(repoRoot, "src", "app", "api", "meetings", "[id]", "route.ts"), "utf8")
  );
  assert.ok(route.includes("finalizeMeetingSave("), "PATCH 必须调用 finalizeMeetingSave（单事务 + 幂等）");
  assert.ok(route.includes('req.headers.get("idempotency-key")'), "PATCH 必须读 Idempotency-Key 请求头");
  assert.ok(route.includes("ensureMeetingLlmResult("), "finalize=true 必须走可重放的 ensureMeetingLlmResult");
  assert.ok(
    !route.includes("createMeetingLlmResult("),
    "PATCH 不该再用 createMeetingLlmResult（会因重试重复生成，issue #74）"
  );
  assert.ok(
    !route.includes("appendMeetingTranscript(") && !route.includes("updateTranscriptMeetingStatus("),
    "PATCH 不该再逐个调 append/update（副作用必须收进 finalizeMeetingSave）"
  );
  assert.ok(
    /IdempotencyInProgressError[\s\S]{0,240}status:\s*409/.test(route),
    "幂等冲突类错误必须映射为 409"
  );
  assert.ok(route.includes("status: 400"), "原有 400 行为必须保留");

  const page = stripComments(readFileSync(join(repoRoot, "src", "app", "page.tsx"), "utf8"));
  const patchCalls = [...page.matchAll(/method:\s*"PATCH",[\s\S]{0,240}/g)].map((match) => match[0]);
  assert.ok(patchCalls.length >= 1, "必须能在 page.tsx 里定位 PATCH 调用");
  assert.ok(
    patchCalls.some((chunk) => chunk.includes('"Idempotency-Key": idempotencyKey')),
    'stopRecordingInner 的 PATCH headers 必须带 "Idempotency-Key": idempotencyKey（与 POST 同一个键）'
  );
});

// ---------------------------------------------------------------------------
// 10. 幂等键必须绑定会议（一审判 V3）
// ---------------------------------------------------------------------------

/** 插一行 meeting_llm_results（字段全按基线表结构给齐；prompt_template_id 有外键，先复用/补建模板）。 */
async function insertLlmResultRow(meetingId, { resultType, status, versionNo }) {
  const database = await getDb();
  const existingTemplate = await database.prepare(`SELECT id FROM llm_prompt_templates LIMIT 1`).get();
  let promptTemplateId = existingTemplate?.id;
  if (!promptTemplateId) {
    promptTemplateId = `tpl-test-${Math.random().toString(16).slice(2)}`;
    const now = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO llm_prompt_templates
         (id, template_key, template_name, template_type, content, description, status, is_system, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(promptTemplateId, promptTemplateId, "测试模板", resultType, "内容", "", "active", 0, now, now);
  }
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO meeting_llm_results
       (id, meeting_id, input_transcript_snapshot, llm_setting_mark, prompt_template_id,
        generation_config_snapshot, generation_mode, status, version_no, result_type,
        result_title, raw_prompt, raw_response, result_markdown, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `llm-test-${Math.random().toString(16).slice(2)}`,
      meetingId,
      "测试用的转写快照",
      "current",
      promptTemplateId,
      JSON.stringify({ source: "test" }),
      "manual_regenerate",
      status,
      versionNo,
      resultType,
      `测试${resultType}`,
      "",
      "",
      "测试正文",
      null,
      now
    );
}

test("用例10：同一个 key 用到别的会议上 → 抛 IdempotencyConflictError，且 B 一行没改、A 也不变", async () => {
  // 变异守卫：删掉 finalizeMeetingSave 里 `claim.meetingId !== input.meetingId` 的抛错 ⇒
  // 对 B 的调用不抱错而是 replayed=true 并返回 A 的会议，下面 assert.rejects 立即转红。
  const meetingA = await newMeeting();
  const meetingB = await newMeeting();
  const key = `save-cross-meeting-${meetingA.id}`;

  // 第 1 步：key 先用在会议 A 上（带标题 + 追加），正常落库。
  const firstOnA = await withActor(() =>
    store.finalizeMeetingSave({
      meetingId: meetingA.id,
      appendTranscriptSegments: [segment("A 的正文")],
      captureSessionId: "capture-cross-a",
      title: "A 的标题",
      idempotencyKey: key,
    })
  );
  assert.equal(firstOnA.replayed, false, "前置：A 首次保存必须真的执行");
  assert.equal(firstOnA.meeting?.title, "A 的标题");

  // 基线：B 与 A 当前的标题 / 段数 / asr 行数
  const bBefore = await withActor(() => store.getMeetingById(meetingB.id));
  const bTitleBefore = bBefore?.title;
  const bSegmentsBefore = (await transcriptOf(meetingB.id)).length;
  const bAsrBefore = await asrRowCount(meetingB.id);
  const aSegmentsBefore = (await transcriptOf(meetingA.id)).length;

  // 第 2 步：同一个 key 打到会议 B 上 → 必须冲突（旧行为：replayed=true 且拿到 A 的会议）。
  await assert.rejects(
    () =>
      withActor(() =>
        store.finalizeMeetingSave({
          meetingId: meetingB.id,
          appendTranscriptSegments: [segment("B 的正文")],
          captureSessionId: "capture-cross-b",
          title: "B 的新标题",
          idempotencyKey: key,
        })
      ),
    (error) => error instanceof store.IdempotencyConflictError,
    "同 key 跳会议必须抛 IdempotencyConflictError（路由映射 409，而不是静默返回 A）"
  );

  const bAfter = await withActor(() => store.getMeetingById(meetingB.id));
  assert.equal(bAfter?.title, bTitleBefore, "B 的标题必须原封不动（旧行为下这里是 B 的旧标题、但断言不会跑列）");
  assert.notEqual(bAfter?.title, "B 的新标题", "B 的标题不能被这次冲突改写");
  assert.equal((await transcriptOf(meetingB.id)).length, bSegmentsBefore, "B 的转写段数必须不变");
  assert.equal(await asrRowCount(meetingB.id), bAsrBefore, "B 不能被写入 meeting_asr_results");

  const aAfter = await withActor(() => store.getMeetingById(meetingA.id));
  assert.equal(aAfter?.title, "A 的标题", "A 仍保有首次保存的结果");
  assert.equal((await transcriptOf(meetingA.id)).length, aSegmentsBefore, "A 的段数不能被这次冲突改变");
});

// ---------------------------------------------------------------------------
// 11. 翻译结果不阻断默认纪要（一审判 V4）
// ---------------------------------------------------------------------------

test("用例11：只有一条 translation 成功结果 → ensureMeetingLlmResult 仍必须 triggered=true", async () => {
  // 变异守卫：把 `&& item.resultType !== "translation"` 去掉 → 这里变成 triggered=false 而转红。
  const meeting = await newMeeting();

  // 与用例5 一致：把 llm.base_url 指向本地桩，使触发的生成能真跑完。
  const database = await getDb();
  await database
    .prepare(`UPDATE app_settings SET item_value = ? WHERE item_section = ? AND item_mark = ?`)
    .run(`http://127.0.0.1:${llmStubPort}/v1`, "llm", "base_url");

  await insertLlmResultRow(meeting.id, { resultType: "translation", status: "succeeded", versionNo: 1 });
  assert.equal(await llmResultCount(meeting.id), 1, "前置：已写入 1 行 translation 成功结果");

  const triggered = await withActor(() => store.ensureMeetingLlmResult(meeting.id));
  assert.equal(triggered.triggered, true, "只做过翻译的会议仍必须触发默认纪要生成（删掉 translation 排除应变红）");

  // 等火忘生成跑完，再看控制组：现在多了一条非 translation 的成功结果，必须改为跳过。
  for (let i = 0; i < 200 && (await llmResultCount(meeting.id)) < 2; i += 1) {
    await llmQueue.whenQuiescent();
  }
  const usableMinutes = await database
    .prepare(
      `SELECT COUNT(*) AS c FROM meeting_llm_results WHERE meeting_id = ? AND result_type <> 'translation' AND status = 'succeeded'`
    )
    .get(meeting.id);
  assert.ok(
    Number(usableMinutes?.c ?? 0) >= 1,
    "前置：触发的生成必须真的写入 1 行非 translation 的成功结果（否则控制组没有意义）"
  );

  const second = await withActor(() => store.ensureMeetingLlmResult(meeting.id));
  assert.equal(second.triggered, false, "已经有一份纪要类成功结果时必须跳过（不能变成无脑重试）");

  await llmQueue.whenQuiescent();
});

// ---------------------------------------------------------------------------
// 12. 404 优先于 400（一审判 V5，路由层源码结构守卫）
// ---------------------------------------------------------------------------

test("用例12：PATCH 路由的存在性 404 必须排在 body.status 参数校验之前", () => {
  // 本仓库测试不拉 Next 服务，拿不到真 HTTP 响应，所以用源码结构守卫：
  // 断言 PATCH 函数体里 `getMeetingById(id)` → 404 的分支位置早于 `body.status !== undefined` 校验。
  // 变异方式：删掉新加的 existing 存在性检查 → notFound === -1 而转红；把它改回校验之后 → 顺序断言转红。
  const route = stripComments(
    readFileSync(join(repoRoot, "src", "app", "api", "meetings", "[id]", "route.ts"), "utf8")
  );
  const patchStart = route.indexOf("export async function PATCH");
  const deleteStart = route.indexOf("export async function DELETE");
  assert.ok(patchStart > -1 && deleteStart > patchStart, "前置：必须能定位 PATCH 函数体");
  const patch = route.slice(patchStart, deleteStart);

  const notFound = patch.search(/getMeetingById\(id\)[\s\S]{0,200}status:\s*404/);
  const statusCheck = patch.indexOf("body.status !== undefined");
  assert.ok(statusCheck > -1, "前置：PATCH 里必须还能定位到 body.status !== undefined 校验");
  assert.ok(notFound > -1, "PATCH 必须有 getMeetingById(id) → 404 的存在性分支");
  assert.ok(
    notFound < statusCheck,
    "存在性检查必须排在参数校验之前：不存在的会议带非法 status 时必须先 404（旧行为）"
  );
});
