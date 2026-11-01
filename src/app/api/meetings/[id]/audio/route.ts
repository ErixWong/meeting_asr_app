/**
 * 会议录音播放 / 下载（feat-261101-01 L5）
 *
 *   GET /api/meetings/<meetingId>/audio                  → 该会议第一条 ready 录音
 *   GET /api/meetings/<meetingId>/audio?recording=<id>   → 指定录音（id 或 captureSessionId）
 *   GET /api/meetings/<meetingId>/audio?download=1       → 加 Content-Disposition: attachment
 *
 * 必须支持 Range：`<audio>` 拖进度条靠它（206 + Content-Range + Accept-Ranges）。
 * 一律流式返回（createReadStream），不把 mp3 整块读进内存。
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getMeetingAudioFile } from "@/lib/admin-store";
import { parseRange } from "@/lib/http-range";

export const dynamic = "force-dynamic";

function buildFileResponse(
  filePath: string,
  size: number,
  mimeType: string,
  options: { range: string | null; downloadFileName?: string | null }
) {
  const baseHeaders: Record<string, string> = {
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  if (options.downloadFileName) {
    const encoded = encodeURIComponent(options.downloadFileName);
    baseHeaders["Content-Disposition"] =
      `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
  }

  const parsed = options.range ? parseRange(options.range, size) : null;

  if (parsed === "invalid") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  if (!parsed) {
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(size) },
    });
  }

  const stream = Readable.toWeb(
    createReadStream(filePath, { start: parsed.start, end: parsed.end })
  ) as ReadableStream<Uint8Array>;
  return new NextResponse(stream, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${parsed.start}-${parsed.end}/${size}`,
      "Content-Length": String(parsed.end - parsed.start + 1),
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const url = new URL(req.url);
    const audio = getMeetingAudioFile({
      meetingId: id,
      recordingId: url.searchParams.get("recording"),
    });
    if (!audio) {
      return NextResponse.json({ error: "Audio not found" }, { status: 404 });
    }

    const download = url.searchParams.get("download");
    return buildFileResponse(audio.filePath, audio.size, audio.mimeType, {
      range: req.headers.get("range"),
      downloadFileName: download ? audio.recording.downloadFileName : null,
    });
  });
}
