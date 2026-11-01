/**
 * 会议录音（feat-261101-01）单测（node --test）
 *
 * 覆盖：
 *   L1 server/audio-recorder.mjs        —— 流式追加 / 字节→时长 / finalize·abort 幂等
 *   L1 server/audio-paths.mjs           —— 存储路径与 data 目录穿越防护
 *   L1 server/runtime-store.mjs         —— audio:* 配置读取（含开关关闭）
 *   L2 server/audio-transcode.mjs       —— PCM→MP3 头/码率/删 pcm/失败保留/幂等
 *   L3 meeting_audio_recordings 表       —— 建表 + 迁移到 v3（旧库路径）
 *   L4 绑定 / 孤儿清理                   —— meeting_id 写入、expires_at 置空、过期删除
 *   R2 列表行音频摘要（F1）/ hasAudio 口径 —— admin-store.ts 音频投影纯函数（源码切片 + tsc 转译）
 *
 * 运行：npm run test:audio（= node --test scripts/audio-test.mjs，需 Node 24）
 * 说明：全部临时文件落在 os.tmpdir() 的沙箱里（测试开始 chdir 进去，data/ 也在
 * 沙箱内），收尾整目录删除，绝不污染仓库。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const sandbox = mkdtempSync(join(tmpdir(), "audio-test-"));
process.chdir(sandbox);

const load = (relativePath) => import(new URL(relativePath, import.meta.url).href);

const { createRecorder, durationSecondsForBytes } = await load("../server/audio-recorder.mjs");
const { rawAudioPath, meetingAudioPath, toStoredPath, resolveStoredPath, ensureAudioDirs } =
  await load("../server/audio-paths.mjs");
const runtimeStore = await load("../server/runtime-store.mjs");
const { getDb: getSharedDb } = await load("../server/db-shared.mjs");

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(rangeCompileDir, { recursive: true, force: true });
});

/** 合成 s16le 单声道正弦波 PCM。 */
function synthesizePcm({ sampleRate = 16000, seconds = 1, freq = 440 } = {}) {
  const sampleCount = Math.round(sampleRate * seconds);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000);
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// L1 audio-paths
// ---------------------------------------------------------------------------

test("audio-paths: raw/mp3 落在 data/audio 下，存储路径相对 data 且可还原", () => {
  ensureAudioDirs();
  const raw = rawAudioPath("capture-abc");
  const mp3 = meetingAudioPath("capture-abc");
  assert.equal(raw, join(sandbox, "data", "audio", "raw", "capture-abc.pcm"));
  assert.equal(mp3, join(sandbox, "data", "audio", "meetings", "capture-abc.mp3"));

  const stored = toStoredPath(mp3);
  assert.equal(stored, "audio/meetings/capture-abc.mp3");
  assert.equal(resolveStoredPath(stored), mp3);
  console.log(`[L1] audio-paths OK: ${stored} → ${resolveStoredPath(stored)}`);
});

test("audio-paths: 路径穿越与非法文件名被拒绝", () => {
  assert.throws(() => resolveStoredPath("../../etc/passwd"), /escapes the data directory/);
  assert.equal(rawAudioPath("../../evil"), join(sandbox, "data", "audio", "raw", ".._.._evil.pcm"));
  assert.throws(() => rawAudioPath(".."), /Invalid audio file name/);
  console.log("[L1] audio-paths 穿越防护 OK");
});

// ---------------------------------------------------------------------------
// L1 audio-recorder
// ---------------------------------------------------------------------------

test("audio-recorder: append 流式落盘 + 字节/时长换算", async () => {
  const pcm = synthesizePcm({ seconds: 1 });
  const recorder = createRecorder({ captureSessionId: "capture-rec-1", sampleRate: 16000 });

  // 分块喂，验证流式写（不依赖单次大 buffer）
  const chunkSize = 3200;
  for (let offset = 0; offset < pcm.length; offset += chunkSize) {
    assert.equal(recorder.append(pcm.subarray(offset, offset + chunkSize)), true);
  }
  assert.equal(recorder.bytes, pcm.length);

  const result = await recorder.finalize();
  assert.equal(result.ok, true);
  assert.equal(result.bytes, pcm.length);
  assert.equal(result.storedPath, "audio/raw/capture-rec-1.pcm");
  assert.equal(existsSync(rawAudioPath("capture-rec-1")), true);
  assert.equal(statSync(rawAudioPath("capture-rec-1")).size, pcm.length);

  // 字节 → 时长：16000 样本/秒 × 2 字节 = 32000 字节/秒
  assert.equal(result.durationSeconds, 1);
  assert.equal(durationSecondsForBytes(32000, 16000), 1);
  assert.equal(durationSecondsForBytes(115_200_000, 16000), 3600);
  assert.equal(durationSecondsForBytes(0, 16000), 0);
  console.log(`[L1] audio-recorder OK: bytes=${result.bytes} duration=${result.durationSeconds}s`);
});

test("audio-recorder: finalize 幂等（同一 Promise、不产生第二个文件、返回首次结果）", async () => {
  const recorder = createRecorder({ captureSessionId: "capture-rec-2", sampleRate: 16000 });
  recorder.append(synthesizePcm({ seconds: 1 }));

  const first = recorder.finalize();
  const second = recorder.finalize();
  assert.equal(first, second, "finalize 应返回同一个 Promise");

  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(statSync(rawAudioPath("capture-rec-2")).size, 32000);

  // finalize 之后再 append 应被忽略（不改变字节数）
  assert.equal(recorder.append(Buffer.alloc(100)), false);
  const third = await recorder.finalize();
  assert.equal(third.bytes, 32000);
  console.log("[L1] finalize 幂等 OK");
});

test("audio-recorder: abort 幂等且删除半截文件", async () => {
  const recorder = createRecorder({ captureSessionId: "capture-rec-3", sampleRate: 16000 });
  recorder.append(synthesizePcm({ seconds: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const result = await recorder.abort();
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(existsSync(rawAudioPath("capture-rec-3")), false);

  const again = await recorder.abort();
  assert.deepEqual(again, result);
  assert.equal(recorder.append(Buffer.alloc(10)), false);
  console.log("[L1] abort 幂等 OK（文件已删）");
});

test("audio-recorder: 未写入任何数据时 finalize 不报错、字节为 0", async () => {
  const recorder = createRecorder({ captureSessionId: "capture-rec-4", sampleRate: 16000 });
  const result = await recorder.finalize();
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 0);
  assert.equal(result.durationSeconds, 0);
  console.log("[L1] 空录制 finalize OK");
});

// ---------------------------------------------------------------------------
// L1 audio:* 配置（开关关闭时不落盘的前提）
// ---------------------------------------------------------------------------

test("audio-config: 默认开 + 码率 48 + 孤儿 TTL 72", () => {
  const config = runtimeStore.getAudioRuntimeConfig();
  assert.equal(config.recordEnabled, true);
  assert.equal(config.bitrateKbps, 48);
  assert.equal(config.orphanTtlHours, 72);
  assert.equal(config.sampleRate, 16000);
  console.log(`[L1] audio 默认配置 OK: ${JSON.stringify(config)}`);
});

test("audio-config: record_enabled=0 时关闭、非法码率回落到 48", () => {
  const database = getSharedDb();
  database
    .prepare("UPDATE app_settings SET item_value = ? WHERE item_section = 'audio' AND item_mark = ?")
    .run("0", "record_enabled");
  database
    .prepare("UPDATE app_settings SET item_value = ? WHERE item_section = 'audio' AND item_mark = ?")
    .run("999", "bitrate_kbps");
  runtimeStore.invalidateAudioRuntimeConfig();

  const config = runtimeStore.getAudioRuntimeConfig();
  assert.equal(config.recordEnabled, false);
  assert.equal(config.bitrateKbps, 48, "非法码率应回落到 48");

  database
    .prepare("UPDATE app_settings SET item_value = ? WHERE item_section = 'audio' AND item_mark = ?")
    .run("1", "record_enabled");
  database
    .prepare("UPDATE app_settings SET item_value = ? WHERE item_section = 'audio' AND item_mark = ?")
    .run("64", "bitrate_kbps");
  runtimeStore.invalidateAudioRuntimeConfig();
  assert.equal(runtimeStore.getAudioRuntimeConfig().bitrateKbps, 64);

  // 复位，避免影响后续转码用例
  database
    .prepare("UPDATE app_settings SET item_value = ? WHERE item_section = 'audio' AND item_mark = ?")
    .run("48", "bitrate_kbps");
  runtimeStore.invalidateAudioRuntimeConfig();
  assert.equal(runtimeStore.getAudioRuntimeConfig().bitrateKbps, 48);
  console.log("[L1] audio 配置校验 OK（0 关闭 / 999→48 / 64 生效 / 复位 48）");
});

// ---------------------------------------------------------------------------
// L2 转码 PCM → MP3
// ---------------------------------------------------------------------------

const transcode = await load("../server/audio-transcode.mjs");
const { transcodePcmToMp3, runAudioTranscodeJob, isMpegAudioHeader } = transcode;

test("transcode: 2 秒正弦 PCM → mp3 同步头 + 码率相符（±10%）", async () => {
  const pcm = synthesizePcm({ seconds: 2 });
  const rawPath = rawAudioPath("capture-tc-1");
  const mp3Path = meetingAudioPath("capture-tc-1");
  ensureAudioDirs();
  writeFileSync(rawPath, pcm);

  const result = await transcodePcmToMp3({ rawPath, mp3Path, bitrateKbps: 48, sampleRate: 16000 });
  const head = readFileSync(mp3Path).subarray(0, 4);
  const expectedBytes = (48_000 / 8) * 2; // 48 kbps × 2 秒

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(isMpegAudioHeader(head), true, `MP3 同步头不合法: ${head.toString("hex")}`);
  assert.equal(head[0], 0xff);
  assert.ok(["f3", "f2", "fb", "fa"].includes(head[1].toString(16)), `同步头第二字节: ${head[1].toString(16)}`);
  assert.equal(statSync(mp3Path).size, result.bytes);
  const delta = Math.abs(result.bytes - expectedBytes) / expectedBytes;
  assert.ok(delta <= 0.1, `字节量 ${result.bytes} 与码率期望 ${expectedBytes} 相差 ${(delta * 100).toFixed(1)}% > 10%`);
  assert.equal(result.durationSeconds, 2);
  assert.equal(existsSync(rawPath), true, "纯文件级转码不负责删 pcm");
  console.log(
    `[L2] transcode OK: head=${head.toString("hex")} bytes=${result.bytes} (期望≈${expectedBytes}, 偏差 ${(delta * 100).toFixed(1)}%)`
  );
});

test("transcode: 目标已存在时幂等跳过（force 才重编）", async () => {
  const rawPath = rawAudioPath("capture-tc-1");
  const mp3Path = meetingAudioPath("capture-tc-1");
  const before = statSync(mp3Path).size;
  const skipped = await transcodePcmToMp3({ rawPath, mp3Path, bitrateKbps: 48 });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.bytes, before);
  console.log(`[L2] 幂等跳过 OK（${before} 字节未变）`);
});

test("transcode: 失败路径不产生半截 mp3、保留 pcm", async () => {
  const rawPath = rawAudioPath("capture-tc-fail");
  const mp3Path = meetingAudioPath("capture-tc-fail");
  ensureAudioDirs();
  writeFileSync(rawPath, synthesizePcm({ seconds: 1 }));
  // 让目标路径变成目录 → openSync 必失败
  const { mkdirSync } = await import("node:fs");
  mkdirSync(mp3Path, { recursive: true });

  await assert.rejects(
    () => transcodePcmToMp3({ rawPath, mp3Path, bitrateKbps: 48 }),
    /EISDIR|EACCES|EPERM/
  );
  assert.equal(existsSync(rawPath), true, "失败必须保留 .pcm");
  assert.equal(statSync(mp3Path).isDirectory(), true, "失败不应留下 mp3 文件");
  rmSync(mp3Path, { recursive: true, force: true });
  console.log("[L2] 失败路径 OK（pcm 保留、无半截 mp3）");
});

test("transcode job: 成功 → 行 status=ready + pcm 已删", async () => {
  const pcm = synthesizePcm({ seconds: 2 });
  const rawPath = rawAudioPath("capture-tc-job-ok");
  ensureAudioDirs();
  writeFileSync(rawPath, pcm);
  runtimeStore.registerAudioRecording({
    captureSessionId: "capture-tc-job-ok",
    sampleRate: 16000,
    rawFilePath: toStoredPath(rawPath),
  });
  runtimeStore.finishAudioRecording({
    captureSessionId: "capture-tc-job-ok",
    rawFilePath: toStoredPath(rawPath),
    bytes: pcm.length,
    durationSeconds: 2,
    ok: true,
  });

  const result = await runAudioTranscodeJob("capture-tc-job-ok");
  const row = runtimeStore.getAudioRecording("capture-tc-job-ok");
  assert.equal(result.ok, true);
  assert.equal(row.status, "ready");
  assert.equal(row.bitrateKbps, 48);
  assert.equal(row.rawFilePath, null, "ready 后 raw_file_path 应清空");
  assert.equal(row.filePath, "audio/meetings/capture-tc-job-ok.mp3");
  assert.equal(row.durationSeconds, 2);
  assert.equal(existsSync(rawPath), false, "转码成功后 .pcm 应删除");
  assert.equal(existsSync(meetingAudioPath("capture-tc-job-ok")), true);
  console.log(`[L2] job OK: status=${row.status} bytes=${row.bytes} file=${row.filePath}`);
});

test("transcode job: 失败 → 行 status=failed + pcm 保留 + error_message", async () => {
  const pcm = synthesizePcm({ seconds: 1 });
  const rawPath = rawAudioPath("capture-tc-job-fail");
  ensureAudioDirs();
  writeFileSync(rawPath, pcm);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(meetingAudioPath("capture-tc-job-fail"), { recursive: true });

  runtimeStore.registerAudioRecording({
    captureSessionId: "capture-tc-job-fail",
    sampleRate: 16000,
    rawFilePath: toStoredPath(rawPath),
  });

  const result = await runAudioTranscodeJob("capture-tc-job-fail");
  const row = runtimeStore.getAudioRecording("capture-tc-job-fail");
  assert.equal(result.ok, false);
  assert.equal(row.status, "failed");
  assert.match(String(row.errorMessage), /transcode failed/);
  assert.equal(existsSync(rawPath), true, "失败必须保留 .pcm");
  rmSync(meetingAudioPath("capture-tc-job-fail"), { recursive: true, force: true });
  console.log(`[L2] job 失败路径 OK: status=${row.status} err=${row.errorMessage}`);
});

test("transcode job: 已 ready 且文件在 → 直接跳过（幂等）", async () => {
  const result = await runAudioTranscodeJob("capture-tc-job-ok");
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "already-ready");
  console.log("[L2] job 幂等跳过 OK");
});

// ---------------------------------------------------------------------------
// L3 schema：meeting_audio_recordings（node:sqlite 运行时路径）
// ---------------------------------------------------------------------------

test("schema: 运行时建表包含 meeting_audio_recordings 全 15 列 + unique capture_session_id", () => {
  const database = getSharedDb();
  const columns = database
    .prepare("PRAGMA table_info(meeting_audio_recordings)")
    .all()
    .map((row) => row.name)
    .sort();
  const expected = [
    "bitrate_kbps", "bytes", "capture_session_id", "created_at", "duration_seconds",
    "error_message", "expires_at", "file_path", "format", "id", "meeting_id",
    "raw_file_path", "sample_rate", "status", "updated_at",
  ];
  assert.deepEqual(columns, expected);

  const indexes = database
    .prepare("PRAGMA index_list(meeting_audio_recordings)")
    .all()
    .map((row) => row.name);
  const uniqueIndex = indexes.some((name) => {
    const cols = database.prepare(`PRAGMA index_info(${name})`).all().map((row) => row.name);
    return cols.length === 1 && cols[0] === "capture_session_id";
  });
  assert.equal(uniqueIndex, true, `capture_session_id 缺 unique 索引: ${indexes.join(",")}`);

  const version = database.prepare("SELECT version FROM schema_version LIMIT 1").get();
  assert.equal(Number(version.version), 3, `schema_version 应为 3，实际 ${version.version}`);
  console.log(`[L3] 运行时 schema OK: 15 列 + unique(capture_session_id) + schema_version=3`);
});

test("schema: 重复登记同一 capture_session_id 走 upsert 不抛唯一键冲突", () => {
  const first = runtimeStore.registerAudioRecording({
    captureSessionId: "capture-upsert-1",
    sampleRate: 16000,
    rawFilePath: "audio/raw/capture-upsert-1.pcm",
  });
  const second = runtimeStore.registerAudioRecording({
    captureSessionId: "capture-upsert-1",
    sampleRate: 16000,
    rawFilePath: "audio/raw/capture-upsert-1.pcm",
  });
  assert.equal(first.id, second.id, "upsert 应保留同一行");
  assert.match(first.id, /^aud-[0-9a-f-]{36}$/, `主键应为 aud-<uuid>，实际 ${first.id}`);
  assert.equal(second.status, "recording");
  const count = getSharedDb()
    .prepare("SELECT COUNT(*) as c FROM meeting_audio_recordings WHERE capture_session_id = ?")
    .get("capture-upsert-1").c;
  assert.equal(Number(count), 1);
  console.log(`[L3] upsert OK: id=${first.id}`);
});

// ---------------------------------------------------------------------------
// L4 绑定 / 孤儿清理 / 删除会议连带删文件
// ---------------------------------------------------------------------------

function seedMeetingRow(meetingId, userId = "user-audio-test") {
  const database = getSharedDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      INSERT INTO users (id, account_name, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
    .run(userId, userId, "录音测试用户", now, now);
  database
    .prepare(`
      INSERT INTO meetings (
        id, title, source_type, duration_seconds, status, status_updated_at,
        created_by_user_id, created_by_user_name, created_at, updated_at
      ) VALUES (?, ?, 'live_recording', 2, 'transcribed', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
    .run(meetingId, "录音绑定测试", now, userId, "录音测试用户", now, now);
  return meetingId;
}

test("bind: 双通道两个 captureSessionId 都绑定到会议且 expires_at 置空（永久）", () => {
  const meetingId = seedMeetingRow("meeting-bind-1");
  ensureAudioDirs();
  for (const captureSessionId of ["capture-dual-mic", "capture-dual-spk"]) {
    writeFileSync(rawAudioPath(captureSessionId), synthesizePcm({ seconds: 1 }));
    runtimeStore.registerAudioRecording({
      captureSessionId,
      sampleRate: 16000,
      rawFilePath: toStoredPath(rawAudioPath(captureSessionId)),
    });
  }
  const beforeRow = runtimeStore.getAudioRecording("capture-dual-mic");
  assert.ok(beforeRow.expiresAt, "绑定前应有 expires_at（孤儿 TTL）");

  const bound = runtimeStore.bindAudioRecordingsToMeeting({
    meetingId,
    captureSessionIds: ["capture-dual-mic", "capture-dual-spk"],
  });
  assert.equal(bound.length, 2);
  for (const row of bound) {
    assert.equal(row.meetingId, meetingId);
    assert.equal(row.expiresAt, null, "已绑定会议的录音 expires_at 必须为 NULL（永久保留）");
  }
  console.log(`[L4] 双通道绑定 OK: ${bound.map((row) => row.captureSessionId).join(", ")}`);
});

test("bind: 单数 captureSessionId 与复数取并集去重（向后兼容旧前端）", () => {
  const meetingId = seedMeetingRow("meeting-bind-2");
  runtimeStore.registerAudioRecording({
    captureSessionId: "capture-legacy-single",
    sampleRate: 16000,
    rawFilePath: "audio/raw/capture-legacy-single.pcm",
  });
  const bound = runtimeStore.bindAudioRecordingsToMeeting({
    meetingId,
    captureSessionId: "capture-legacy-single",
    captureSessionIds: ["capture-legacy-single", "capture-legacy-single", ""],
  });
  assert.equal(bound.length, 1);
  assert.equal(bound[0].captureSessionId, "capture-legacy-single");
  assert.equal(runtimeStore.collectCaptureSessionIds({
    captureSessionId: "a",
    captureSessionIds: ["a", "b", "", null, "b"],
  }).join(","), "a,b");
  console.log("[L4] 单数/复数并集去重 OK");
});

test("cleanup: 只清 meeting_id IS NULL 且过期的孤儿，删行 + 删文件", () => {
  const database = getSharedDb();
  ensureAudioDirs();
  const orphanId = "capture-orphan-expired";
  const orphanMp3 = meetingAudioPath(orphanId);
  writeFileSync(rawAudioPath(orphanId), synthesizePcm({ seconds: 1 }));
  writeFileSync(orphanMp3, Buffer.from("mp3"));
  runtimeStore.registerAudioRecording({
    captureSessionId: orphanId,
    sampleRate: 16000,
    rawFilePath: toStoredPath(rawAudioPath(orphanId)),
  });
  database
    .prepare("UPDATE meeting_audio_recordings SET file_path = ?, expires_at = ? WHERE capture_session_id = ?")
    .run(toStoredPath(orphanMp3), new Date(Date.now() - 60_000).toISOString(), orphanId);

  const result = runtimeStore.cleanupExpiredAudioRecordings();
  assert.ok(result.rows >= 1, `应至少清掉 1 行孤儿，实际 ${result.rows}`);
  assert.equal(runtimeStore.getAudioRecording(orphanId), null, "孤儿行应被删除");
  assert.equal(existsSync(rawAudioPath(orphanId)), false, "孤儿 raw 文件应被删除");
  assert.equal(existsSync(orphanMp3), false, "孤儿 mp3 文件应被删除");

  // 已绑定会议的录音（expires_at IS NULL）绝不能被清
  assert.notEqual(runtimeStore.getAudioRecording("capture-dual-mic"), null);
  console.log(`[L4] 孤儿清理 OK: rows=${result.rows} files=${result.files}`);
});

test("cleanup: 未过期的孤儿不动", () => {
  runtimeStore.registerAudioRecording({
    captureSessionId: "capture-orphan-fresh",
    sampleRate: 16000,
    rawFilePath: "audio/raw/capture-orphan-fresh.pcm",
  });
  const before = runtimeStore.getAudioRecording("capture-orphan-fresh");
  runtimeStore.cleanupExpiredAudioRecordings();
  assert.notEqual(runtimeStore.getAudioRecording("capture-orphan-fresh"), null);
  assert.ok(new Date(before.expiresAt).getTime() > Date.now(), "默认 TTL 72h 应远未过期");
  console.log("[L4] 未过期孤儿保留 OK");
});

test("delete: 删会议时音频行与文件一并清掉（含残留 pcm）", () => {
  const meetingId = seedMeetingRow("meeting-delete-1");
  const captureSessionId = "capture-del-1";
  ensureAudioDirs();
  writeFileSync(rawAudioPath(captureSessionId), synthesizePcm({ seconds: 1 }));
  writeFileSync(meetingAudioPath(captureSessionId), Buffer.from("mp3"));
  runtimeStore.registerAudioRecording({
    captureSessionId,
    sampleRate: 16000,
    rawFilePath: toStoredPath(rawAudioPath(captureSessionId)),
  });
  runtimeStore.bindAudioRecordingsToMeeting({ meetingId, captureSessionIds: [captureSessionId] });
  getSharedDb()
    .prepare("UPDATE meeting_audio_recordings SET file_path = ?, status = 'ready' WHERE capture_session_id = ?")
    .run(toStoredPath(meetingAudioPath(captureSessionId)), captureSessionId);

  // deleteMeeting 的内部两步：事务内取行 + 删行，提交后删文件
  const rows = runtimeStore.listAudioRecordingsForMeeting(meetingId);
  assert.equal(rows.length, 1);
  runtimeStore.deleteAudioRecordingRowsForMeeting(meetingId);
  const { files } = runtimeStore.removeAudioFilesForRows(rows);

  assert.equal(files, 2, `应删除 mp3 + pcm 两个文件，实际 ${files}`);
  assert.equal(existsSync(meetingAudioPath(captureSessionId)), false);
  assert.equal(existsSync(rawAudioPath(captureSessionId)), false);
  assert.equal(runtimeStore.listAudioRecordingsForMeeting(meetingId).length, 0);
  console.log("[L4] 删会议连带删文件 OK（mp3 + 残留 pcm）");
});

// ---------------------------------------------------------------------------
// L5 Range 语义（`<audio>` 拖进度条的前提）
// ---------------------------------------------------------------------------

const rangeCompileDir = mkdtempSync(join(tmpdir(), "audio-test-range-"));

// 注意：本文件已经 chdir 到沙箱，所以 tsc 必须用绝对路径调本地依赖（不能用 npx，
// 否则会在沙箱里现下 tsc）。仓库根从 import.meta.url 反推。
const repoRoot = new URL("..", import.meta.url).pathname;

async function loadRangeModule() {
  const { spawnSync } = await import("node:child_process");
  const tsc = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      join(repoRoot, "src", "lib", "http-range.ts"),
      "--outDir",
      rangeCompileDir,
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--skipLibCheck",
    ],
    { encoding: "utf-8" }
  );
  if (tsc.status !== 0) {
    throw new Error(`tsc 编译 http-range.ts 失败: ${tsc.stdout ?? ""}${tsc.stderr ?? ""}`);
  }
  return import(new URL(`file://${join(rangeCompileDir, "http-range.js")}`).href);
}

test("range: bytes=a-b / a- / -N 与越界 416 语义", async () => {
  const { parseRange } = await loadRangeModule();
  const size = 1000;

  assert.deepEqual(parseRange("bytes=0-99", size), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", size), { start: 100, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", size), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-99999", size), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=999-999", size), { start: 999, end: 999 });

  assert.equal(parseRange(null, size), null, "无 Range 头应回 200 全量");
  assert.equal(parseRange("", size), null);
  assert.equal(parseRange("bytes=2000-", size), "invalid", "起点越界应 416");
  assert.equal(parseRange("bytes=100-50", size), "invalid", "start>end 应 416");
  assert.equal(parseRange("bytes=abc", size), "invalid");
  assert.equal(parseRange("bytes=-", size), "invalid");
  assert.equal(parseRange("bytes=-0", size), "invalid");
  console.log("[L5] Range 语义 OK（200/206/416 三条分支）");
});

// ---------------------------------------------------------------------------
// R2 返工防回归：列表行必须带出音频摘要（F1）+ hasAudio 口径统一
//
// 断言的是**哪一层**：`src/lib/admin-store.ts` 里 `#region meeting-audio-projection`
// 区间的**真实源码**（不是测试里的副本）。admin-store.ts 依赖 `@/` 别名与 next 运行时，
// 在 node --test 里不能直接 import，所以按标记切出纯函数区间，用项目自带 tsc
// 转译后在 vm 里执行，断言 listMeetings / getMeetingById 共用的那个投影函数的输出。
// 若有人把 `audioRecordings: []` 写回列表、或往输出里塞磁盘路径，这些用例会挂。
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
  assert.equal(
    typeof moduleShim.exports.projectMeetingAudio,
    "function",
    "投影区间里应导出 projectMeetingAudio（列表与详情共用的口径函数）"
  );
  return moduleShim.exports;
}

const AUDIO_CLIENT_KEYS = [
  "bitrateKbps",
  "bytes",
  "captureSessionId",
  "createdAt",
  "downloadFileName",
  "durationSeconds",
  "errorMessage",
  "format",
  "id",
  "status",
].sort();

function audioRow(overrides = {}) {
  return {
    id: "aud-00000000-0000-0000-0000-000000000001",
    captureSessionId: "capture-list-1",
    meetingId: "meeting-list-1",
    // 真实行里这两个字段是**磁盘路径**（存储相对路径），投影必须把它们挡在输出之外
    filePath: "audio/meetings/capture-list-1.mp3",
    rawFilePath: "audio/raw/capture-list-1.pcm",
    format: "mp3",
    status: "ready",
    bytes: 1_048_576,
    durationSeconds: 174,
    sampleRate: 16000,
    bitrateKbps: 48,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

test("R2/F1: 列表行投影带出 audioRecordings 且字段齐全（白名单，含 id/status/durationSeconds/bytes/downloadFileName）", async () => {
  const { projectMeetingAudio } = await loadMeetingAudioProjection();
  const result = projectMeetingAudio([audioRow()], "周会");

  assert.equal(Array.isArray(result.audioRecordings), true, "audioRecordings 必须是数组");
  assert.equal(result.audioRecordings.length, 1, "列表行不能再是空数组");
  const [item] = result.audioRecordings;

  for (const key of ["id", "status", "durationSeconds", "bytes", "downloadFileName"]) {
    assert.ok(key in item, `列表行缺字段 ${key}`);
    assert.notEqual(item[key], undefined, `列表行字段 ${key} 不能是 undefined`);
  }
  assert.deepEqual(Object.keys(item).sort(), AUDIO_CLIENT_KEYS, "输出字段集合必须等于白名单（多一个都可能泄路径）");
  assert.equal(item.status, "ready");
  assert.equal(item.durationSeconds, 174);
  assert.equal(item.bytes, 1_048_576);
  assert.equal(item.downloadFileName, "周会.mp3");
  console.log(`[R2] 列表行音频摘要字段齐全 OK: ${Object.keys(item).join(",")}`);
});

test("R2/F1: hasAudio 口径统一为「存在 status=ready」（列表与详情同一个函数）", async () => {
  const { projectMeetingAudio } = await loadMeetingAudioProjection();

  assert.equal(projectMeetingAudio([audioRow({ status: "ready" })], "会").hasAudio, true);

  // 只有 recording（刚录完、转码中）→ 不算有可听录音
  const recordingOnly = projectMeetingAudio([audioRow({ status: "recording" })], "会");
  assert.equal(recordingOnly.hasAudio, false, "只有 recording 时 hasAudio 必须为 false（口径=存在 ready）");
  assert.equal(recordingOnly.audioRecordings.length, 1, "但条目本身要带出来，UI 才能显示「录音处理中…」");

  // 只有 failed → 同样 false，但条目要带出来（UI 要显示 errorMessage）
  const failedOnly = projectMeetingAudio([audioRow({ status: "failed", errorMessage: "transcode failed" })], "会");
  assert.equal(failedOnly.hasAudio, false);
  assert.equal(failedOnly.audioRecordings[0].errorMessage, "transcode failed");

  // 双通道：一条 ready 一条 failed → true
  const mixed = projectMeetingAudio(
    [audioRow({ id: "aud-a", status: "failed" }), audioRow({ id: "aud-b", status: "ready" })],
    "会"
  );
  assert.equal(mixed.hasAudio, true);
  assert.equal(mixed.audioRecordings.length, 2);
  assert.equal(mixed.audioRecordings[0].downloadFileName, "会-1.mp3");
  assert.equal(mixed.audioRecordings[1].downloadFileName, "会-2.mp3");

  // 空 / null / undefined（没有录音的会议）
  for (const empty of [[], null, undefined]) {
    const result = projectMeetingAudio(empty, "会");
    assert.equal(result.hasAudio, false);
    // 注意：投影跑在 vm 里，返回的是另一个 realm 的数组，不能用 deepStrictEqual 比原型
    assert.equal(Array.isArray(result.audioRecordings), true);
    assert.equal(result.audioRecordings.length, 0);
  }
  console.log("[R2] hasAudio 口径统一 OK（ready→true；recording/failed/空→false）");
});

test("R2/F1: 列表行不透出磁盘绝对/存储路径（键名与值都检查）", async () => {
  const { projectMeetingAudio } = await loadMeetingAudioProjection();
  const absoluteRow = audioRow({
    filePath: join(sandbox, "data", "audio", "meetings", "capture-list-1.mp3"),
    rawFilePath: join(sandbox, "data", "audio", "raw", "capture-list-1.pcm"),
  });
  const result = projectMeetingAudio([absoluteRow], "周会");
  const item = result.audioRecordings[0];

  for (const key of Object.keys(item)) {
    assert.doesNotMatch(key, /path|dir|raw/i, `输出字段 ${key} 看起来是路径字段`);
  }
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /audio\/(meetings|raw)/, `输出里出现了存储路径: ${serialized}`);
  assert.doesNotMatch(serialized, /sandbox|\/app\/data|\.pcm|\.mp3\?/, `输出里出现了磁盘路径: ${serialized}`);
  assert.equal(serialized.includes(sandbox), false, "输出里出现了沙箱绝对路径");
  // 唯一允许出现的 .mp3 是下载文件名
  assert.match(item.downloadFileName, /^周会\.mp3$/);
  console.log(`[R2] 无路径外泄 OK: ${serialized}`);
});

test("R2/F1: listMeetings 走同一投影 + 批量 SQL 不查路径列（防退回 N+1 / 防退回空数组）", () => {
  const source = readFileSync(ADMIN_STORE_PATH, "utf-8");
  const listMeetingsSource = sliceBetween(source, "export function listMeetings()", "function queryMeetingRowById");

  assert.match(listMeetingsSource, /listMeetingAudioRowsByMeeting\(\)/, "列表必须用一次性批量查询");
  assert.match(listMeetingsSource, /projectMeetingAudio\(/, "列表必须走与详情同一个投影函数");
  assert.doesNotMatch(listMeetingsSource, /audioRecordings:\s*\[\]/, "列表行不许再写死 audioRecordings: []");
  assert.doesNotMatch(listMeetingsSource, /listAudioRecordingsForMeeting/, "列表里不许出现按会议逐条查（N+1）");

  const batchSource = sliceBetween(
    source,
    "function listMeetingAudioRowsByMeeting()",
    "export function listMeetings()"
  );
  assert.doesNotMatch(batchSource, /r\.file_path|r\.raw_file_path/, "批量查询不许 SELECT 磁盘路径列");
  assert.match(batchSource, /NULL as filePath/);

  // hasAudio 只允许由投影结果赋值（口径一致），不许各处自算
  const projectionRegion = sliceBetween(
    source,
    "// #region meeting-audio-projection",
    "// #endregion meeting-audio-projection"
  );
  assert.equal(
    (projectionRegion.match(/hasAudio: audioRecordings\.some/g) ?? []).length,
    1,
    "hasAudio 口径只应在投影函数里算一次"
  );
  const outsideProjection = source.replace(projectionRegion, "");
  assert.doesNotMatch(outsideProjection, /hasAudio: audioRecordings\.some/, "投影之外不许再自算 hasAudio 口径");
  assert.doesNotMatch(outsideProjection, /hasAudio:\s*\(audioSummaries/, "旧的 count>0 口径已废弃");
  assert.doesNotMatch(source, /listMeetingAudioSummaries/, "旧的 count>0 口径已废弃");
  assert.equal(
    (source.match(/hasAudio: audio\.hasAudio/g) ?? []).length,
    3,
    "listMeetings / getMeetingLightById / getMeetingById 三处都应写 hasAudio: audio.hasAudio"
  );
  console.log("[R2] listMeetings 复用投影 + 批量查询无路径列 OK");
});
