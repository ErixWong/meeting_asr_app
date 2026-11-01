/**
 * 会议录音磁盘布局（feat-261101-01）
 *
 * 全部音频都落在 `process.cwd()/data/audio` 下（compose 已把 ./.docker/data
 * bind mount 到 /app/data，所以生产环境零配置持久化）：
 *
 *   data/audio/raw/<captureSessionId>.pcm      旁路录制的原始 PCM（转码成功后删除）
 *   data/audio/meetings/<captureSessionId>.mp3 转码产物（绑定会议后永久保留）
 *
 * DB 里存的是**相对 data 目录的路径**（如 `audio/meetings/capture-xxx.mp3`），
 * 这样容器内外路径一致、换挂载点不用改数据；resolveStoredPath() 负责还原成
 * 绝对路径，并对 `..` 穿越做兜底。
 */
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const AUDIO_SEGMENT = "audio";
const RAW_SEGMENT = "raw";
const MEETINGS_SEGMENT = "meetings";
const SAFE_NAME_PATTERN = /[^A-Za-z0-9._-]/g;

export function getDataDir() {
  return join(process.cwd(), "data");
}

export function getAudioRootDir() {
  return join(getDataDir(), AUDIO_SEGMENT);
}

export function getRawAudioDir() {
  return join(getAudioRootDir(), RAW_SEGMENT);
}

export function getMeetingAudioDir() {
  return join(getAudioRootDir(), MEETINGS_SEGMENT);
}

export function ensureAudioDirs() {
  for (const dir of [getRawAudioDir(), getMeetingAudioDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** captureSessionId 只应含 [A-Za-z0-9._-]；其余字符折叠成 `_` 防路径注入。 */
export function safeFileName(value) {
  const normalized = String(value ?? "").trim().replace(SAFE_NAME_PATTERN, "_");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Invalid audio file name");
  }
  return normalized;
}

export function rawAudioPath(captureSessionId) {
  return join(getRawAudioDir(), `${safeFileName(captureSessionId)}.pcm`);
}

export function meetingAudioPath(captureSessionId) {
  return join(getMeetingAudioDir(), `${safeFileName(captureSessionId)}.mp3`);
}

/** 绝对路径 → 相对 data 目录的存储路径（正斜杠，跨平台一致）。 */
export function toStoredPath(absolutePath) {
  if (!absolutePath) return null;
  const dataDir = getDataDir();
  const target = resolve(String(absolutePath));
  const relativePath = relative(dataDir, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return target.split(sep).join("/");
  }
  return relativePath.split(sep).join("/");
}

/** 存储路径 → 绝对路径；越出 data 目录的一律拒绝。 */
export function resolveStoredPath(storedPath) {
  if (!storedPath) return null;
  const raw = String(storedPath);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(getDataDir(), raw);
  const dataDir = resolve(getDataDir());
  const relativePath = relative(dataDir, absolute);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Audio path escapes the data directory");
  }
  return absolute;
}
