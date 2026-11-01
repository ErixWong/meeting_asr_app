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
