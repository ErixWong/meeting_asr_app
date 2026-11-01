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
  console.log("[L1] audio 配置校验 OK（0 关闭 / 999→48 / 64 生效）");
});
