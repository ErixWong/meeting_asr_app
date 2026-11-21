/**
 * 音频投影纯函数（chore-261121-06 从 `admin-store.ts` 抽出，god module 拆分第 1 步）。
 *
 * 这里是「列表与详情共用」的音频投影**唯一实现**：
 * - `listMeetings`（列表）与 `getMeetingById` / `getMeetingLightById`（详情）都走 `projectMeetingAudio`，
 *   `hasAudio` 的口径因此只有一处定义；
 * - **字段白名单也在这里**：磁盘路径（`filePath` / `rawFilePath`）永远不许出现在客户端输出里；
 * - `toClientAudioRow` 也被 `admin-store.getMeetingAudioFile` 直接复用（播放/下载响应里的 `recording` 字段）。
 *
 * 本文件必须保持**零 import、零副作用**：不碰 DB、不读文件、不依赖 `@/` 别名与 next 运行时。
 * `scripts/audio-test.mjs` 与 `scripts/audio-retention-test.mjs` 会按下面两个 `#region` 标记
 * 把源码切出来（tsc 转译后在 vm 里跑）做防回归断言，所以：
 * **别把这两个标记删了/挪到别的函数上**，也别往区间里塞有副作用的代码或 import。
 */

// #region meeting-audio-projection
// ⚠ 本区间是「列表与详情共用」的音频投影纯函数：不 import 任何模块、不碰 DB、不读文件。
// scripts/audio-test.mjs 会按这两个标记把源码切出来（tsc 转译后在 vm 里跑）做防回归断言，
// 所以：**别把这两个标记删了/挪到别的函数上**，也别往区间里塞有副作用的代码。
// 字段白名单也在这里：磁盘路径（file_path / raw_file_path）永远不许出现在输出里。

export type MeetingAudioRow = {
  id: string;
  captureSessionId: string;
  meetingId: string | null;
  filePath: string | null;
  rawFilePath: string | null;
  format: string;
  status: string;
  bytes: number;
  durationSeconds: number;
  sampleRate: number;
  bitrateKbps: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type MeetingAudioClientRow = {
  id: string;
  captureSessionId: string;
  status: string;
  format: string;
  bytes: number;
  durationSeconds: number;
  bitrateKbps: number | null;
  errorMessage: string | null;
  createdAt: string;
  downloadFileName: string;
};

export function toClientAudioRow(
  row: MeetingAudioRow,
  meetingTitle: string,
  index: number,
  total: number
): MeetingAudioClientRow {
  const baseName = String(meetingTitle || "录音").trim() || "录音";
  return {
    id: row.id,
    captureSessionId: row.captureSessionId,
    status: row.status,
    format: row.format,
    bytes: row.bytes,
    durationSeconds: row.durationSeconds,
    bitrateKbps: row.bitrateKbps,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    // 双通道时带序号，避免两个下载文件同名
    downloadFileName: total > 1 ? `${baseName}-${index + 1}.mp3` : `${baseName}.mp3`,
  };
}

/**
 * 列表与详情**共用**的音频投影（R2 修 F1/F2 的口径统一点）：
 * - `audioRecordings`：白名单字段的客户端行，不含任何磁盘路径；
 * - `hasAudio`：统一口径 = **存在 `status === "ready"` 的条目**（「有没有可听的」）。
 *   历史列表曾经用 `COUNT(*) > 0`（recording 也算 true），与详情 `some(ready)` 不一致，已废弃。
 */
export function projectMeetingAudio(
  rows: MeetingAudioRow[] | null | undefined,
  meetingTitle: string
): { hasAudio: boolean; audioRecordings: MeetingAudioClientRow[] } {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const audioRecordings = list.map((row, index) => toClientAudioRow(row, meetingTitle, index, list.length));
  return {
    hasAudio: audioRecordings.some((item) => item.status === "ready"),
    audioRecordings,
  };
}
// #endregion meeting-audio-projection
