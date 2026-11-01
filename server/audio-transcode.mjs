/**
 * PCM → MP3 转码（feat-261101-01 L2）
 *
 * 用 `@breezystack/lamejs`（纯 ESM 包，**必须具名 import**：`createRequire()`
 * 拿到的是空对象，`new Mp3Encoder` 会抛 TypeError）。
 *
 * 设计约束：
 *   - 分块读 PCM（13824 字节 = 6912 样本/块），**绝不 readFileSync 整个文件**
 *     （1 小时 ≈ 115 MB）。
 *   - 每 N 块 `await setImmediate()` 让出事件循环：lamejs 是纯 JS，编码期间会
 *     占满 CPU；分片让出可避免整台 Next.js 服务被一场会议的转码冻住。
 *   - 幂等：目标 mp3 已存在（且调用方已确认 status=ready）→ 直接跳过。
 *   - 失败保留 .pcm，成功删 .pcm。
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Mp3Encoder } from "@breezystack/lamejs";
import { meetingAudioPath, resolveStoredPath, toStoredPath } from "./audio-paths.mjs";
import {
  getAudioRecording,
  getAudioRuntimeConfig,
  markAudioRecordingFailed,
  markAudioRecordingReady,
} from "./runtime-store.mjs";

/** 6912 样本/块 × 2 字节 = 13824 字节（lame 的 MPEG-1 帧长 1152 的整数倍）。 */
const READ_CHUNK_BYTES = 13_824;
const YIELD_EVERY_BLOCKS = 32;
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BITRATE_KBPS = 48;

/**
 * 纯文件级转码。目标 mp3 已存在且 force=false 时跳过（幂等）。
 * 失败时删掉半截 mp3 并抛出（调用方负责保留 .pcm / 记 status=failed）。
 */
export async function transcodePcmToMp3({
  rawPath,
  mp3Path,
  bitrateKbps = DEFAULT_BITRATE_KBPS,
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = 1,
  force = false,
} = {}) {
  if (!rawPath || !existsSync(rawPath)) throw new Error(`PCM file not found: ${rawPath}`);
  if (!mp3Path) throw new Error("mp3Path is required");

  const resolvedSampleRate = Number(sampleRate) > 0 ? Number(sampleRate) : DEFAULT_SAMPLE_RATE;
  const resolvedBitrate = Number(bitrateKbps) > 0 ? Number(bitrateKbps) : DEFAULT_BITRATE_KBPS;

  if (!force && isNonEmptyFile(mp3Path)) {
    return {
      ok: true,
      skipped: true,
      mp3Path,
      storedPath: toStoredPath(mp3Path),
      bytes: statSync(mp3Path).size,
      bitrateKbps: resolvedBitrate,
      sampleRate: resolvedSampleRate,
      durationSeconds: statSync(rawPath).size / 2 / resolvedSampleRate,
    };
  }

  mkdirSync(dirname(mp3Path), { recursive: true });

  const encoder = new Mp3Encoder(channels, resolvedSampleRate, resolvedBitrate);
  const readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
  let inputFd = null;
  let outputFd = null;
  let bytesWritten = 0;
  let blocks = 0;

  try {
    inputFd = openSync(rawPath, "r");
    outputFd = openSync(mp3Path, "w");

    for (;;) {
      const readBytes = readSync(inputFd, readBuffer, 0, READ_CHUNK_BYTES, null);
      if (readBytes <= 0) break;
      const usableBytes = readBytes - (readBytes % 2);
      if (usableBytes <= 0) continue;

      const samples = new Int16Array(usableBytes / 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = readBuffer.readInt16LE(index * 2);
      }

      const encoded = encoder.encodeBuffer(samples);
      if (encoded.length > 0) {
        const outBuffer = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.length);
        writeSync(outputFd, outBuffer);
        bytesWritten += outBuffer.length;
      }

      blocks += 1;
      if (blocks % YIELD_EVERY_BLOCKS === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    const tail = encoder.flush();
    if (tail.length > 0) {
      const tailBuffer = Buffer.from(tail.buffer, tail.byteOffset, tail.length);
      writeSync(outputFd, tailBuffer);
      bytesWritten += tailBuffer.length;
    }

    closeSync(inputFd);
    closeSync(outputFd);
    inputFd = null;
    outputFd = null;

    const durationSeconds = statSync(rawPath).size / 2 / resolvedSampleRate;
    return {
      ok: true,
      skipped: false,
      mp3Path,
      storedPath: toStoredPath(mp3Path),
      bytes: bytesWritten,
      bitrateKbps: resolvedBitrate,
      sampleRate: resolvedSampleRate,
      durationSeconds,
    };
  } catch (error) {
    for (const fd of [inputFd, outputFd]) {
      if (fd === null) continue;
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭失败：下面的 unlink 才是关键清理
      }
    }
    try {
      if (isNonEmptyFile(mp3Path)) unlinkSync(mp3Path);
    } catch (cleanupError) {
      console.error("[Audio Transcode] failed to remove partial mp3:", cleanupError);
    }
    throw error;
  }
}

function isNonEmptyFile(filePath) {
  if (!filePath) return false;
  try {
    const stats = statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function safeResolveStoredPath(storedPath) {
  try {
    return resolveStoredPath(storedPath);
  } catch (error) {
    console.error("[Audio Transcode] invalid stored path:", storedPath, error);
    return null;
  }
}

const inFlightJobs = new Set();

/**
 * 异步排一个转码任务（不阻塞调用方）。网关 finalize 后用它，接口/WS 先返回。
 */
export function enqueueAudioTranscode(captureSessionId) {
  if (!captureSessionId || inFlightJobs.has(captureSessionId)) return;
  inFlightJobs.add(captureSessionId);
  setImmediate(() => {
    void runAudioTranscodeJob(captureSessionId)
      .catch((error) => {
        console.error(`[Audio Transcode] job failed (${captureSessionId}):`, error);
      })
      .finally(() => {
        inFlightJobs.delete(captureSessionId);
      });
  });
}

/**
 * 执行一次转码任务（幂等）：
 *   status=ready 且 mp3 在 → 跳过；
 *   成功 → status=ready + 删 .pcm；
 *   失败 → status=failed + 保留 .pcm + error_message。
 */
export async function runAudioTranscodeJob(captureSessionId) {
  const row = getAudioRecording(captureSessionId);
  if (!row) return { ok: false, skipped: true, reason: "no-recording-row" };

  const mp3Path = meetingAudioPath(captureSessionId);
  if (row.status === "ready" && row.filePath && isNonEmptyFile(safeResolveStoredPath(row.filePath))) {
    return { ok: true, skipped: true, reason: "already-ready", filePath: row.filePath };
  }

  const rawPath = row.rawFilePath ? safeResolveStoredPath(row.rawFilePath) : null;
  if (!rawPath || !existsSync(rawPath)) {
    markAudioRecordingFailed({ captureSessionId, errorMessage: "raw pcm file is missing" });
    return { ok: false, skipped: false, reason: "raw-missing" };
  }

  const config = getAudioRuntimeConfig();
  try {
    const result = await transcodePcmToMp3({
      rawPath,
      mp3Path,
      bitrateKbps: config.bitrateKbps,
      sampleRate: row.sampleRate || DEFAULT_SAMPLE_RATE,
    });

    markAudioRecordingReady({
      captureSessionId,
      filePath: result.storedPath,
      bytes: result.bytes,
      durationSeconds: result.durationSeconds,
      bitrateKbps: result.bitrateKbps,
    });

    try {
      if (existsSync(rawPath)) unlinkSync(rawPath);
    } catch (error) {
      console.error(`[Audio Transcode] failed to remove pcm (${captureSessionId}):`, error);
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markAudioRecordingFailed({ captureSessionId, errorMessage: `transcode failed: ${message}` });
    return { ok: false, skipped: false, reason: "transcode-failed", error: message };
  }
}

/** MP3 同步头检查（MPEG audio frame sync：0xFF + 高 3 位全 1）。 */
export function isMpegAudioHeader(buffer) {
  if (!buffer || buffer.length < 2) return false;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}
