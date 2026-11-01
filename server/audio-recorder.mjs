/**
 * 服务端旁路 PCM 录制（feat-261101-01 L1）
 *
 * 上游 `/asr` 网关收到的音频是 PCM s16le / 16 kHz / 单声道裸流。这里把它原样
 * 追加到 `data/audio/raw/<captureSessionId>.pcm`，会议结束后由 audio-transcode
 * 转成 mp3。要点：
 *
 *   - **流式写**：用 fs.createWriteStream，绝不把整场 PCM 攒在内存里
 *     （1 小时 ≈ 115 MB）。
 *   - **绝不拖累转发**：append() 内部吞掉所有写错误（只打日志并记到
 *     writeError），调用方不需要 try/catch，更不该因此 failSession。
 *   - **幂等**：finalize()/abort() 重复调用返回同一个 Promise（首次结果）。
 */
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { rawAudioPath, toStoredPath } from "./audio-paths.mjs";

/** PCM s16le 单声道：每采样 2 字节。 */
const BYTES_PER_SAMPLE = 2;
const DEFAULT_SAMPLE_RATE = 16000;

export function durationSecondsForBytes(bytes, sampleRate = DEFAULT_SAMPLE_RATE) {
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : DEFAULT_SAMPLE_RATE;
  const safeBytes = Number(bytes) > 0 ? Number(bytes) : 0;
  return safeBytes / BYTES_PER_SAMPLE / rate;
}

export function createRecorder({ captureSessionId, sampleRate = DEFAULT_SAMPLE_RATE, rawPath } = {}) {
  if (!captureSessionId) throw new Error("captureSessionId is required");

  const resolvedSampleRate = Number(sampleRate) > 0 ? Number(sampleRate) : DEFAULT_SAMPLE_RATE;
  const filePath = rawPath ? String(rawPath) : rawAudioPath(captureSessionId);
  const storedPath = toStoredPath(filePath);

  let stream = null;
  let bytes = 0;
  let writeError = null;
  let finished = null;
  let aborted = false;

  function ensureStream() {
    if (stream) return stream;
    mkdirSync(dirname(filePath), { recursive: true });
    stream = createWriteStream(filePath, { flags: "w" });
    stream.on("error", (error) => {
      writeError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Audio Recorder] write failed (${captureSessionId}):`, writeError.message);
    });
    return stream;
  }

  function snapshot() {
    return {
      captureSessionId,
      ok: !writeError && !aborted,
      aborted,
      error: writeError ? writeError.message : null,
      rawPath: filePath,
      storedPath,
      bytes,
      sampleRate: resolvedSampleRate,
      durationSeconds: durationSecondsForBytes(bytes, resolvedSampleRate),
    };
  }

  function append(chunk) {
    if (finished || aborted) return false;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? []);
    if (buffer.length === 0) return true;

    try {
      const activeStream = ensureStream();
      activeStream.write(buffer);
      bytes += buffer.length;
      return true;
    } catch (error) {
      writeError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Audio Recorder] append failed (${captureSessionId}):`, writeError.message);
      return false;
    }
  }

  function finalize() {
    if (finished) return finished;
    finished = new Promise((resolvePromise) => {
      if (!stream) {
        resolvePromise(snapshot());
        return;
      }
      stream.end(() => resolvePromise(snapshot()));
    });
    return finished;
  }

  function abort() {
    if (finished) return finished;
    aborted = true;
    finished = new Promise((resolvePromise) => {
      const done = () => {
        try {
          if (existsSync(filePath)) unlinkSync(filePath);
        } catch (error) {
          console.error(`[Audio Recorder] abort cleanup failed (${captureSessionId}):`, error);
        }
        const result = snapshot();
        bytes = 0;
        resolvePromise({ ...result, ok: false, bytes: 0, durationSeconds: 0 });
      };
      if (!stream) {
        done();
        return;
      }
      stream.once("close", done);
      stream.destroy();
    });
    return finished;
  }

  return {
    captureSessionId,
    sampleRate: resolvedSampleRate,
    get rawPath() {
      return filePath;
    },
    get storedPath() {
      return storedPath;
    },
    get bytes() {
      return bytes;
    },
    get durationSeconds() {
      return durationSecondsForBytes(bytes, resolvedSampleRate);
    },
    get finished() {
      return Boolean(finished);
    },
    append,
    finalize,
    abort,
  };
}

/** 已落盘文件大小（转码任务恢复/校验用）。 */
export function statRawFile(rawPath) {
  try {
    if (!rawPath || !existsSync(rawPath)) return null;
    return statSync(rawPath).size;
  } catch {
    return null;
  }
}
