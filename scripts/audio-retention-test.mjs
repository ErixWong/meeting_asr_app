/**
 * 绑定录音保留策略单测（feat-261103-01 / issue #57，node --test）
 *
 * 覆盖工单 8 条「要实现的行为」里可自动化的部分：
 *   1. 新设置 audio.bound_retention_days（默认 365，0 = 永久）真的落库并被读进配置
 *   2. 迁移 v5：purged_at 补列；v4 库 → v5 单行；**两次独立进程**验证「重复启动不重跑」
 *   3. 到期清理：365 天到期 → 删 MP3 + status='purged' + purged_at + file_path 保留，
 *      转写/会议不动；0 = 永久一行不清；未到期不动；删除失败保行 + error_message 落库
 *   4. 节拍复用：runAudioMaintenance() 串起「水位检查 + 孤儿清理 + 到期清理」
 *   5. UI 投影：清理后 hasAudio=false（断言的是 admin-store.ts 真实投影源码切片）
 *   6. 磁盘水位：阈值命中/不命中，命中时 console.warn 含实际剩余与阈值
 *   7. dry-run：只记日志，不删文件、不改状态
 *   8. 跨库红线：本脚本与实现里不出现裸写 ON CONFLICT / LIMIT / PRAGMA（源码级断言）
 *
 * 运行：npm run test:retention（= node --test scripts/audio-retention-test.mjs，需 Node 24）
 * 说明：全部临时文件落在 os.tmpdir() 的沙箱里（测试开始 chdir 进去，data/ 也在沙箱内），
 * 收尾整目录删除，绝不污染仓库。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const sandbox = mkdtempSync(join(tmpdir(), "audio-retention-test-"));
process.chdir(sandbox);

const repoRoot = new URL("..", import.meta.url).pathname;
const load = (relativePath) => import(new URL(relativePath, import.meta.url).href);

const runtimeStore = await load("../server/runtime-store.mjs");
const { getDb: getSharedDb, closeDb } = await load("../server/db-shared.mjs");
const { ensureAudioDirs, meetingAudioPath, toStoredPath } = await load("../server/audio-paths.mjs");

after(async () => {
  // 关连接池：不关 node --test 会挂在未释放的池句柄上
  await closeDb();
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 抓取一段逻辑里的 console 输出（log / warn / error 一起收） */
async function captureConsole(fn) {
  const logs = [];
  const warns = [];
  const errors = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => logs.push(args.map((v) => String(v)).join(" "));
  console.warn = (...args) => warns.push(args.map((v) => String(v)).join(" "));
  console.error = (...args) => errors.push(args.map((v) => String(v)).join(" "));
  try {
    const result = await fn();
    return { result, logs, warns, errors };
  } finally {
    Object.assign(console, original);
  }
}

async function setAudioSetting(mark, value) {
  const database = await getSharedDb();
  await database
    .prepare("UPDATE app_settings SET item_value = ? WHERE item_section = 'audio' AND item_mark = ?")
    .run(String(value), mark);
  runtimeStore.invalidateAudioRuntimeConfig();
}

/** 去掉注释行（跨库红线断言只看真实 SQL，不看解释性注释） */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

async function seedMeeting(meetingId, userId = `user-${meetingId}`) {
  const database = await getSharedDb();
  const now = new Date().toISOString();
  await database
    .prepare(`
      INSERT INTO users (id, account_name, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `)
    .run(userId, userId, "保留策略测试用户", now, now);
  await database
    .prepare(`
      INSERT INTO meetings (
        id, title, source_type, duration_seconds, status, status_updated_at,
        created_by_user_id, created_by_user_name, created_at, updated_at
      ) VALUES (?, ?, 'live_recording', 2, 'transcribed', ?, ?, ?, ?, ?)
    `)
    .run(meetingId, `保留策略-${meetingId}`, now, userId, "保留策略测试用户", now, now);
  // 转写（用于断言「到期清理不动转写」）
  await database
    .prepare(`
      INSERT INTO meeting_asr_results (
        id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot,
        capture_session_id, result_format, raw_payload, normalized_text, created_at
      ) VALUES (?, ?, 'local_funasr', 'asr-mark', '{}', ?, 'json', '{}', ?, ?)
    `)
    .run(`asr-${meetingId}`, meetingId, `capture-${meetingId}`, "转写正文不能因为录音清理消失", now);
  return meetingId;
}

/**
 * 直接造一行录音。`bound=true` 表示已绑定会议（meeting_id 非空、expires_at NULL）。
 * `ageDays` 用来把 updated_at 推到 N 天前。
 */
async function seedRecording({
  id,
  meetingId,
  captureSessionId = `capture-${id}`,
  status = "ready",
  ageDays = 400,
  bytes = 1024,
  withFile = true,
  filePath = null,
} = {}) {
  const database = await getSharedDb();
  ensureAudioDirs();
  const updatedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  let storedPath = filePath;
  if (withFile) {
    const absolute = meetingAudioPath(captureSessionId);
    writeFileSync(absolute, Buffer.from("ID3-fake-mp3"));
    storedPath = toStoredPath(absolute);
  }
  await database
    .prepare(`
      INSERT INTO meeting_audio_recordings (
        id, capture_session_id, meeting_id, file_path, raw_file_path, format, status,
        bytes, duration_seconds, sample_rate, bitrate_kbps, error_message,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, NULL, 'mp3', ?, ?, 2, 16000, 48, NULL, ?, ?, ?)
    `)
    .run(
      id,
      captureSessionId,
      meetingId ?? null,
      storedPath,
      status,
      bytes,
      updatedAt,
      updatedAt,
      meetingId ? null : new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
    );
  return { id, captureSessionId, storedPath, updatedAt };
}

const audioRow = (id) => runtimeStore.getAudioRecordingById(id);

/** 每个保留策略用例从干净状态开始（行 + data/audio/meetings 下的文件一起清） */
async function resetRecordings() {
  const database = await getSharedDb();
  await database.prepare("DELETE FROM meeting_audio_recordings").run();
  rmSync(join(sandbox, "data", "audio", "meetings"), { recursive: true, force: true });
  ensureAudioDirs();
}

// ---------------------------------------------------------------------------
// 1. 新设置：默认值 + 真的落库
// ---------------------------------------------------------------------------

test("retention-config: audio.bound_retention_days 默认 365 / disk_warn_gb 默认 5 / dry_run 默认 0，三键均落库", async () => {
  // 先走一次 runtime-store 的配置读取（内部 getDb() → seedAsrDefaults 播默认设置）
  await runtimeStore.getAudioRuntimeConfig();
  const database = await getSharedDb();
  const rows = await database
    .prepare("SELECT item_mark as mark, item_value as value FROM app_settings WHERE item_section = 'audio'")
    .all();
  const byMark = Object.fromEntries(rows.map((row) => [row.mark, row.value]));
  assert.deepEqual(
    Object.keys(byMark).sort(),
    ["bitrate_kbps", "bound_retention_days", "disk_warn_gb", "orphan_ttl_hours", "record_enabled", "retention_dry_run"],
    `audio 段应有 6 个键，实际 ${JSON.stringify(byMark)}`
  );
  assert.equal(byMark.bound_retention_days, "365");
  assert.equal(byMark.disk_warn_gb, "5");
  assert.equal(byMark.retention_dry_run, "0");

  const config = await runtimeStore.getAudioRuntimeConfig();
  assert.equal(config.boundRetentionDays, 365, "默认保留 365 天");
  assert.equal(config.diskWarnGb, 5, "默认磁盘阈值 5 GB");
  assert.equal(config.retentionDryRun, false, "默认非演练模式");
  // 既有键语义未变
  assert.equal(config.orphanTtlHours, 72);
  assert.equal(config.bitrateKbps, 48);
  console.log(`[R1] audio 配置 OK: ${JSON.stringify(config)}`);
});

// ---------------------------------------------------------------------------
// 3a. 到期清理：365 天到期 → 删 MP3 + purged，转写不动
// ---------------------------------------------------------------------------

test("retention: 到期（400 天前）已绑定录音 → 删 MP3、status=purged、purged_at 落库、file_path 保留、转写与会议不动", async () => {
  await resetRecordings();
  const meetingId = await seedMeeting("meeting-ret-expired");
  const seeded = await seedRecording({ id: "aud-expired-1", meetingId, bytes: 4096 });
  assert.equal(existsSync(join(sandbox, "data", seeded.storedPath)), true, "夹具：MP3 应存在");

  const result = await runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 365 } });
  assert.equal(result.retentionDays, 365);
  assert.equal(result.purged, 1, `应清理 1 行，实际 ${JSON.stringify(result)}`);
  assert.equal(result.failed, 0);
  assert.equal(result.bytes, 4096, "释放字节数应等于该行 bytes");

  const row = await audioRow("aud-expired-1");
  assert.notEqual(row, null, "行必须保留（只删 MP3）");
  assert.equal(row.status, "purged", "状态应置 purged");
  assert.ok(row.purgedAt, "purged_at 必须落库");
  assert.ok(Math.abs(Date.parse(row.purgedAt) - Date.now()) < 60_000, `purged_at 应是清理时刻，实际 ${row.purgedAt}`);
  assert.equal(row.filePath, seeded.storedPath, "file_path 必须保留（审计用）");
  assert.equal(existsSync(join(sandbox, "data", seeded.storedPath)), false, "MP3 文件应被删除");

  // 转写与会议不动
  const database = await getSharedDb();
  const meeting = await database.prepare("SELECT id, title FROM meetings WHERE id = ?").get(meetingId);
  assert.equal(meeting?.id, meetingId, "会议本身不能被动");
  const asr = await database.prepare("SELECT normalized_text FROM meeting_asr_results WHERE meeting_id = ?").get(meetingId);
  assert.equal(asr?.normalized_text, "转写正文不能因为录音清理消失", "转写必须保留");
  console.log(`[R3] 到期清理 OK: ${JSON.stringify(result)}，转写/会议保留`);
});

// ---------------------------------------------------------------------------
// 3b. 0 = 永久
// ---------------------------------------------------------------------------

test("retention: bound_retention_days=0 → 永久保留，一行都不清（文件/状态都不动）", async () => {
  await resetRecordings();
  const meetingId = await seedMeeting("meeting-ret-permanent");
  const seeded = await seedRecording({ id: "aud-permanent-1", meetingId, ageDays: 3650 });

  const result = await runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 0 } });
  assert.equal(result.purged, 0, `0=永久，不应清理任何行，实际 ${JSON.stringify(result)}`);
  assert.equal(result.scanned, 0);
  assert.equal(result.cutoff, null);

  const row = await audioRow("aud-permanent-1");
  assert.equal(row.status, "ready", "状态必须保持 ready");
  assert.equal(row.purgedAt, null, "purged_at 必须仍为 NULL");
  assert.equal(existsSync(join(sandbox, "data", seeded.storedPath)), true, "MP3 文件必须还在");
  console.log("[R3] 0=永久保留 OK（一行不清）");
});

// ---------------------------------------------------------------------------
// 3c. 未到期不动
// ---------------------------------------------------------------------------

test("retention: 未到期（updated_at 在保留期内）不动；孤儿（meeting_id 为空）也不由本策略处理", async () => {
  await resetRecordings();
  const meetingId = await seedMeeting("meeting-ret-fresh");
  const fresh = await seedRecording({ id: "aud-fresh-1", meetingId, ageDays: 10 });
  // 孤儿行：meeting_id 为空 + expires_at 未来 → 既不该被到期清理，也不该被孤儿清理
  const orphan = await seedRecording({ id: "aud-orphan-fresh", meetingId: null, ageDays: 400 });

  const result = await runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 365 } });
  assert.equal(result.purged, 0, `未到期行不应被清，实际 ${JSON.stringify(result)}`);
  assert.equal(result.scanned, 0);

  assert.equal((await audioRow("aud-fresh-1")).status, "ready");
  assert.equal(existsSync(join(sandbox, "data", fresh.storedPath)), true);
  assert.equal((await audioRow("aud-orphan-fresh")).status, "ready", "孤儿录音不归到期策略管");
  assert.equal(existsSync(join(sandbox, "data", orphan.storedPath)), true);
  console.log("[R3] 未到期 + 孤儿均不动 OK");
});

// ---------------------------------------------------------------------------
// 3d. 删除失败保行
// ---------------------------------------------------------------------------

test("retention: 删除 MP3 失败 → 不改状态（仍 ready）、error_message 落库、updated_at 不动、下一轮仍会被重试", async () => {
  await resetRecordings();
  const meetingId = await seedMeeting("meeting-ret-fail");
  const seeded = await seedRecording({ id: "aud-fail-1", meetingId, ageDays: 400 });
  // 让 unlink 失败：把 MP3 路径换成目录（unlink 目录 → EISDIR/EPERM）
  const absolute = join(sandbox, "data", seeded.storedPath);
  rmSync(absolute, { force: true });
  mkdirSync(absolute, { recursive: true });

  const first = await runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 365 } });
  assert.equal(first.failed, 1, `删除失败应记 failed=1，实际 ${JSON.stringify(first)}`);
  assert.equal(first.purged, 0);

  const row = await audioRow("aud-fail-1");
  assert.equal(row.status, "ready", "删除失败绝不能置 purged");
  assert.equal(row.purgedAt, null, "删除失败不能写 purged_at");
  assert.ok(row.errorMessage, "失败原因必须写进 error_message");
  assert.match(row.errorMessage, /EISDIR|EPERM|EACCES|directory/i, `error_message 应含原因，实际 ${row.errorMessage}`);
  assert.equal(row.updatedAt, seeded.updatedAt, "updated_at 不能被动（否则重试会被推后一整个保留期）");
  assert.equal(existsSync(absolute), true, "文件（目录）仍在");

  // 幂等 + 重试：修好之后下一轮能清掉
  rmSync(absolute, { recursive: true, force: true });
  writeFileSync(absolute, Buffer.from("ID3-fake-mp3"));
  const second = await runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 365 } });
  assert.equal(second.purged, 1, `修复后下一轮应清掉，实际 ${JSON.stringify(second)}`);
  const fixed = await audioRow("aud-fail-1");
  assert.equal(fixed.status, "purged");
  assert.equal(fixed.errorMessage, null, "成功清理后应清空 error_message");
  console.log(`[R3] 删除失败保行 + 下一轮重试 OK（error_message=${row.errorMessage}）`);
});

// ---------------------------------------------------------------------------
// 3e. 幂等重跑
// ---------------------------------------------------------------------------

test("retention: 幂等重跑 → 第二次 purged=0 不报错、不重复删；文件已不存在视为成功", async () => {
  await resetRecordings();
  const meetingId = await seedMeeting("meeting-ret-idem");
  const seeded = await seedRecording({ id: "aud-idem-1", meetingId, ageDays: 400 });
  // 文件先被人删掉（磁盘丢文件）→ 目标状态已达成，按成功处理
  rmSync(join(sandbox, "data", seeded.storedPath), { force: true });

  const first = await runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 365 } });
  assert.equal(first.purged, 1, `文件已不存在也应置 purged（幂等），实际 ${JSON.stringify(first)}`);

  const second = await runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 365 } });
  assert.equal(second.scanned, 0, `第二次不应再有候选行，实际 ${JSON.stringify(second)}`);
  assert.equal(second.purged, 0);
  assert.equal((await audioRow("aud-idem-1")).status, "purged");
  console.log("[R3] 幂等重跑 OK（scanned=0）");
});

// ---------------------------------------------------------------------------
// 3f. dry-run
// ---------------------------------------------------------------------------

test("retention: dry_run=1 → 只记「将清理 X 行 / 释放 Y 字节」，不删文件、不改状态", async () => {
  await resetRecordings();
  const meetingId = await seedMeeting("meeting-ret-dry");
  const seeded = await seedRecording({ id: "aud-dry-1", meetingId, ageDays: 400, bytes: 2048 });

  const { result, logs } = await captureConsole(async () =>
    runtimeStore.purgeExpiredBoundAudioRecordings({ config: { boundRetentionDays: 365, retentionDryRun: true } })
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.purged, 0, "演练模式不许删");
  assert.equal(result.scanned, 1);
  assert.equal(result.bytes, 2048);
  const line = logs.find((entry) => entry.includes("dry-run"));
  assert.ok(line, `应有一条 dry-run 日志，实际 ${JSON.stringify(logs)}`);
  assert.match(line, /将清理 1 行/);
  assert.match(line, /释放 2048 字节/);

  const row = await audioRow("aud-dry-1");
  assert.equal(row.status, "ready", "演练模式不许改状态");
  assert.equal(row.purgedAt, null);
  assert.equal(existsSync(join(sandbox, "data", seeded.storedPath)), true, "演练模式不许删文件");
  console.log(`[R7] dry-run OK: ${line}`);
});

// ---------------------------------------------------------------------------
// 5. UI 投影：清理后 hasAudio=false
// ---------------------------------------------------------------------------

const ADMIN_STORE_PATH = join(repoRoot, "src", "lib", "admin-store.ts");

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `admin-store.ts 里找不到起点标记: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `admin-store.ts 里找不到终点标记: ${endNeedle}`);
  return source.slice(start, end);
}

async function loadMeetingAudioProjection() {
  const source = readFileSync(ADMIN_STORE_PATH, "utf-8");
  const snippet = sliceBetween(
    source,
    "// #region meeting-audio-projection",
    "// #endregion meeting-audio-projection"
  );
  const tsModule = await import(join(repoRoot, "node_modules", "typescript", "lib", "typescript.js"));
  const ts = tsModule.default ?? tsModule;
  const { outputText } = ts.transpileModule(snippet, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const moduleShim = { exports: {} };
  runInNewContext(outputText, { module: moduleShim, exports: moduleShim.exports, console });
  assert.equal(typeof moduleShim.exports.projectMeetingAudio, "function");
  return moduleShim.exports;
}

test("projection: 到期清理后列表/详情共用投影 hasAudio=false，但条目仍带出（UI 才能说「已到期清理」）", async () => {
  const { projectMeetingAudio } = await loadMeetingAudioProjection();
  const base = {
    id: "aud-proj-1",
    captureSessionId: "capture-proj-1",
    meetingId: "meeting-proj-1",
    filePath: "audio/meetings/capture-proj-1.mp3",
    rawFilePath: null,
    format: "mp3",
    bytes: 4096,
    durationSeconds: 174,
    sampleRate: 16000,
    bitrateKbps: 48,
    errorMessage: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    expiresAt: null,
  };

  const ready = projectMeetingAudio([{ ...base, status: "ready" }], "周会");
  assert.equal(ready.hasAudio, true, "夹具：ready 时 hasAudio=true");

  const purged = projectMeetingAudio([{ ...base, status: "purged", purgedAt: "2026-11-03T00:00:00.000Z" }], "周会");
  assert.equal(purged.hasAudio, false, "purged 之后 hasAudio 必须为 false（列表不再显示「有录音」）");
  assert.equal(purged.audioRecordings.length, 1, "条目要带出来，详情页才能提示「已到期清理」");
  assert.equal(purged.audioRecordings[0].status, "purged");
  // 投影仍然不许透出磁盘路径
  assert.equal(JSON.stringify(purged).includes("audio/meetings"), false, "输出里不许出现存储路径");
  console.log(`[R5] 投影 hasAudio 口径 OK: purged → ${purged.hasAudio}`);
});

// ---------------------------------------------------------------------------
// 6. 磁盘水位
// ---------------------------------------------------------------------------

test("disk: 阈值命中/不命中 —— 低于阈值 active=true 且 console.warn 含实际剩余与阈值；高于阈值 active=false", async () => {
  // 不命中：阈值 0 GB（free < 0 不可能成立）
  const low = await runtimeStore.getAudioDiskStatus({ config: { diskWarnGb: 0 } });
  assert.equal(low.active, false, `阈值 0 不应告警，实际 ${JSON.stringify(low)}`);
  assert.equal(typeof low.freeBytes, "number");
  assert.ok(low.freeBytes > 0, "statfs 应读到可用空间");

  // 命中：阈值 1 PB（任何机器都低于它）
  const huge = 1024 * 1024;
  const hit = await captureConsole(async () => {
    const status = await runtimeStore.checkAudioDiskWatermark({ config: { diskWarnGb: huge } });
    return status;
  });
  assert.equal(hit.result.active, true, `阈值 ${huge} GB 必须命中，实际 ${JSON.stringify(hit.result)}`);
  assert.equal(hit.result.thresholdGb, huge);
  assert.equal(hit.warns.length, 1, `命中阈值应打一条 console.warn，实际 ${JSON.stringify(hit.warns)}`);
  const warnLine = hit.warns[0];
  assert.match(warnLine, /磁盘可用空间告警/);
  assert.ok(warnLine.includes(hit.result.freeGb.toFixed(2)), `告警要含实际剩余，实际 ${warnLine}`);
  assert.ok(warnLine.includes(String(huge)), `告警要含阈值，实际 ${warnLine}`);

  // 不命中时不许告警
  const quiet = await captureConsole(async () => runtimeStore.checkAudioDiskWatermark({ config: { diskWarnGb: 0 } }));
  assert.equal(quiet.warns.length, 0, "未命中阈值不应告警");
  console.log(`[R6] 水位 OK: free=${hit.result.freeGb.toFixed(2)}GB / 阈值 ${huge}GB 命中；阈值 0 不命中`);
});

// ---------------------------------------------------------------------------
// 4. 节拍复用：runAudioMaintenance 串起三条
// ---------------------------------------------------------------------------

test("maintenance: runAudioMaintenance 一次跑完「水位 + 孤儿清理 + 到期清理」，孤儿 72h 语义未变", async () => {
  await resetRecordings();
  const meetingId = await seedMeeting("meeting-ret-maint");
  const expired = await seedRecording({ id: "aud-maint-expired", meetingId, ageDays: 400 });
  // 真孤儿：meeting_id 为空 + expires_at 已过期
  const orphan = await seedRecording({ id: "aud-maint-orphan", meetingId: null, ageDays: 5 });
  const database = await getSharedDb();
  await database
    .prepare("UPDATE meeting_audio_recordings SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), "aud-maint-orphan");

  await setAudioSetting("bound_retention_days", "365");
  await setAudioSetting("retention_dry_run", "0");
  await setAudioSetting("disk_warn_gb", "0");

  const { result } = await captureConsole(async () => runtimeStore.runAudioMaintenance());
  assert.equal(result.retention.purged, 1, `到期清理应清 1 行，实际 ${JSON.stringify(result.retention)}`);
  assert.equal(result.orphan.rows, 1, `孤儿清理应清 1 行（72h 语义未变），实际 ${JSON.stringify(result.orphan)}`);
  assert.equal(result.disk.active, false);

  assert.equal((await audioRow("aud-maint-expired")).status, "purged", "绑定到期 → 保行置 purged");
  assert.equal(existsSync(join(sandbox, "data", expired.storedPath)), false);
  assert.equal(await audioRow("aud-maint-orphan"), null, "孤儿行仍按老语义删行");
  assert.equal(existsSync(join(sandbox, "data", orphan.storedPath)), false, "孤儿文件仍按老语义删除");
  console.log(`[R4] runAudioMaintenance OK: ${JSON.stringify({ retention: result.retention.purged, orphan: result.orphan.rows })}`);
});

// ---------------------------------------------------------------------------
// 2. 迁移 v5（两次独立进程）
// ---------------------------------------------------------------------------

const DB_SHARED_URL = pathToFileURL(join(repoRoot, "server", "db-shared.mjs")).href;
const ASYNC_DB_URL = pathToFileURL(join(repoRoot, "server", "db", "async-db.mjs")).href;
const SCHEMA_URL = pathToFileURL(join(repoRoot, "server", "db", "schema.mjs")).href;

const migrationChildPath = join(sandbox, "migration-child.mjs");
writeFileSync(
  migrationChildPath,
  `// 子进程：模拟「启动一次服务」。mode=prepare 造 v4 库；mode=open 走生产入口 getDb()。
const mode = process.argv[2];
const { getDb, closeDb } = await import(${JSON.stringify(DB_SHARED_URL)});
const { listTableColumns } = await import(${JSON.stringify(ASYNC_DB_URL)});

if (mode === "prepare") {
  // 先用生产入口建到最新（v5），再把 purged_at 列删掉、版本改回 4 —— 等价于生产 v4 库
  const db = await getDb();
  await db.exec("ALTER TABLE meeting_audio_recordings DROP COLUMN purged_at");
  await db.prepare("DELETE FROM schema_version").run();
  await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(4);
  const versions = (await db.prepare("SELECT version FROM schema_version").all()).map((r) => Number(r.version));
  const columns = await listTableColumns(db, "meeting_audio_recordings");
  console.log("PREPARED " + JSON.stringify({ versions, hasPurgedAt: columns.includes("purged_at") }));
  await closeDb();
} else {
  const db = await getDb();
  const versions = (await db.prepare("SELECT version FROM schema_version").all()).map((r) => Number(r.version));
  const columns = await listTableColumns(db, "meeting_audio_recordings");
  console.log("OPENED " + JSON.stringify({ versions, hasPurgedAt: columns.includes("purged_at") }));
  await closeDb();
}
`
);

function runMigrationChild(mode, dbPath) {
  const child = spawnSync(process.execPath, [migrationChildPath, mode], {
    cwd: sandbox,
    env: { ...process.env, DB_TYPE: "sqlite", SQLITE_PATH: dbPath, NODE_ENV: "test" },
    encoding: "utf-8",
    timeout: 120_000,
  });
  assert.equal(child.status, 0, `子进程 ${mode} 失败: ${child.stderr}`);
  return `${child.stdout}\n${child.stderr}`;
}

test("migration: 生产库 v4（[4] 单行、无 purged_at）→ 起两次进程 → 第一次迁移到 [5] 单行并补列，第二次不重跑", async () => {
  const dbPath = join(sandbox, "data", "migration-v4.db");
  const preparedLog = runMigrationChild("prepare", dbPath);
  assert.match(preparedLog, /"versions":\[4\]/, `夹具应造出 [4] 单行，实际 ${preparedLog}`);
  assert.match(preparedLog, /"hasPurgedAt":false/, `夹具应没有 purged_at 列，实际 ${preparedLog}`);

  // 第一次启动：必须看到 v5 迁移
  const firstLog = runMigrationChild("open", dbPath);
  assert.match(firstLog, /Migration applied: v5 \(meeting-audio-recordings-purged-at\)/, `第一次启动应跑 v5 迁移，实际 ${firstLog}`);
  assert.match(firstLog, /"versions":\[5\]/, `迁移后必须是 [5] 单行，实际 ${firstLog}`);
  assert.match(firstLog, /"hasPurgedAt":true/, `迁移后必须有 purged_at 列，实际 ${firstLog}`);

  // 第二次启动：不许重跑（单行记账 + 幂等补列）
  const secondLog = runMigrationChild("open", dbPath);
  assert.doesNotMatch(secondLog, /Migration applied/, `第二次启动不许再跑迁移，实际 ${secondLog}`);
  assert.match(secondLog, /"versions":\[5\]/, `第二次启动后仍是 [5] 单行，实际 ${secondLog}`);
  assert.match(secondLog, /"hasPurgedAt":true/);
  console.log("[R2] 迁移 v4→v5 两次进程 OK: [4] → [5] 单行，第二次无 Migration applied");
});

test("migration: 全新库直接是 v5 且带 purged_at（新库不靠迁移补列）", async () => {
  const dbPath = join(sandbox, "data", "fresh-v5.db");
  const log = runMigrationChild("open", dbPath);
  assert.match(log, /"versions":\[5\]/);
  assert.match(log, /"hasPurgedAt":true/);
  assert.doesNotMatch(log, /Migration applied/, "全新库不应跑任何迁移");
  console.log("[R2] 全新库 v5 + purged_at OK");
});

// ---------------------------------------------------------------------------
// 8. 跨库红线（源码级）
// ---------------------------------------------------------------------------

test("dialect: 新增实现不裸写 ON CONFLICT / LIMIT / PRAGMA（跨库红线，场景0 同口径）", () => {
  const runtimeRaw = readFileSync(join(repoRoot, "server", "runtime-store.mjs"), "utf-8");
  // 只检查本单新增的保留策略段落，避免误伤既有代码
  const start = runtimeRaw.indexOf("// 绑定录音保留策略（feat-261103-01 / issue #57）");
  assert.ok(start > 0, "runtime-store.mjs 里应能找到保留策略段落标记");
  const region = stripComments(runtimeRaw.slice(start));
  assert.doesNotMatch(region, /ON\s+CONFLICT/i, "不许裸写 ON CONFLICT（走 upsert/insertIgnore）");
  assert.doesNotMatch(region, /\bPRAGMA\b/i, "不许裸写 PRAGMA");
  assert.doesNotMatch(region, /\bLIMIT\s+\d/i, "不许裸写 LIMIT（走 limitFragment）");

  const schemaRaw = readFileSync(join(repoRoot, "server", "db", "schema.mjs"), "utf-8");
  const migrationRegion = stripComments(sliceBetween(schemaRaw, "version: 5,", "version: 4,"));
  assert.match(migrationRegion, /addColumnIfAbsent\(/, "v5 迁移必须走跨库 addColumnIfAbsent()");
  assert.doesNotMatch(migrationRegion, /\bPRAGMA\b/i, "v5 迁移不许裸写 PRAGMA");
  assert.doesNotMatch(migrationRegion, /ADD\s+COLUMN/i, "v5 迁移不许裸写 ADD COLUMN 方言语法");
  console.log("[R8] 跨库红线 OK: 无 ON CONFLICT / LIMIT / PRAGMA 裸写，补列走 addColumnIfAbsent()");
});

// ---------------------------------------------------------------------------
// 5b. UI 分支存在性（详情页「已到期清理」+ 常驻告警条）
// ---------------------------------------------------------------------------

test("ui: 详情页对 purged 有专门文案（不是「录音处理中…」）、顶部告警条 role=alert 且不自动消失", () => {
  const pageSource = readFileSync(join(repoRoot, "src", "app", "page.tsx"), "utf-8");
  assert.match(
    pageSource,
    /recording\.status === "purged"/,
    "详情页必须有 purged 分支，否则清理后会落到「录音处理中…」"
  );
  assert.match(pageSource, /录音已到期清理（转写仍保留）/, "必须给用户明确文案");
  assert.match(pageSource, /role="alert"/, "顶部告警条必须是 role=alert（常驻，不做 toast）");
  assert.match(pageSource, /audioDiskAlert/, "告警条应绑定磁盘水位状态");
  // 常驻：告警条不许挂定时消失（#61 的模式）
  const alertIndex = pageSource.indexOf("audioDiskAlert &&");
  assert.ok(alertIndex > 0, "告警条应使用 audioDiskAlert && 条件渲染");
  const alertBlock = pageSource.slice(alertIndex, alertIndex + 3000);
  assert.doesNotMatch(alertBlock, /setTimeout\(/, "告警条不许自动消失");
  console.log("[R5] UI 分支 OK: purged 文案 + 常驻 role=alert 告警条");
});
