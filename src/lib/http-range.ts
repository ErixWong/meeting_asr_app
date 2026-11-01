/**
 * HTTP Range 解析（feat-261101-01 L5）
 *
 * 只服务会议录音的 `GET /api/meetings/<id>/audio`，但刻意抽成无依赖的纯函数：
 * `<audio>` 拖进度条完全依赖这里的语义正确（206 + Content-Range）。
 *
 * 返回值：
 *   null      —— 没有 Range 头（调用方回 200 全量）
 *   "invalid" —— 语法错/越界（调用方回 416 + `bytes *\/size`）
 *   {start,end} —— 闭区间字节范围（调用方回 206）
 */
export type ByteRange = { start: number; end: number };

export function parseRange(header: string | null | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) return "invalid";

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  let start: number;
  let end: number;

  if (!rawStart) {
    // bytes=-N → 最后 N 字节
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start > end || start >= total) return "invalid";
  return { start, end: Math.min(end, total - 1) };
}
