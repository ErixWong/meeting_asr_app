import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  appendMeetingTranscriptWithOutcome,
  completeIdempotencyKey,
  createMeetingLlmResult,
  deleteMeeting,
  getMeetingById,
  getMeetingLightById,
  releaseIdempotencyKey,
  updateMeeting,
  updateTranscriptMeetingStatus,
  IdempotencyInProgressError,
  IdempotencyConflictError,
} from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const view = new URL(req.url).searchParams.get("view");
    const meeting = view === "light" ? await getMeetingLightById(id) : await getMeetingById(id);
    if (!meeting) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ meeting });
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    // fix-261123-04 验收 X2：幂等键完成要覆盖 PATCH 的**全部副作用**（追加 + 标题 + 状态 + LLM 触发），
    // 所以把 idempotencyKey / appendClaimToken 提到 try 外，让 catch 能在中途报错时 release 令牌。
    const idempotencyKey = req.headers.get("idempotency-key");
    let appendClaimToken: string | null = null;
    try {
      const body = await req.json();
      let meeting = await getMeetingById(id);

      if (!meeting) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      if (Array.isArray(body.appendTranscriptSegments)) {
        // fix-261123-04（issue #74-3）：只透传幂等键，去重逻辑在 appendMeetingTranscriptWithOutcome 里。
        // X2：append 只负责追加，complete 由本路由在所有副作用做完后调用（见下方）。
        const appendOutcome = await appendMeetingTranscriptWithOutcome({
          meetingId: id,
          captureSessionId: String(body.captureSessionId ?? `capture-${Date.now()}`),
          captureSessionIds: Array.isArray(body.captureSessionIds) ? body.captureSessionIds : undefined,
          transcriptSegments: body.appendTranscriptSegments,
          idempotencyKey,
        });
        meeting = appendOutcome.meeting;
        if (appendOutcome.replayed) {
          // 幂等重放：这次请求的副作用上次已经全部写完（追加 + 标题 + 状态 + finalize 的 LLM 触发），
          // 不能再跑一遍，否则会给同一会议重复生成纪要（验收 W6）。
          return NextResponse.json({ meeting });
        }
        appendClaimToken = appendOutcome.claimToken;
      }

      if (body.title !== undefined) {
        meeting = await updateMeeting(id, { title: body.title });
      }

      if (body.status !== undefined) {
        if (body.status !== "paused" && body.status !== "transcribed") {
          return NextResponse.json({ error: "Unsupported meeting status" }, { status: 400 });
        }
        if (body.status === "transcribed" && body.finalize !== true) {
          return NextResponse.json({ error: "Finalized meetings must set finalize=true" }, { status: 400 });
        }
        meeting = await updateTranscriptMeetingStatus(id, body.status, body.lastErrorMessage ?? null);
      } else if (body.finalize === true) {
        return NextResponse.json({ error: "finalize requires status=transcribed" }, { status: 400 });
      }

      if (body.finalize === true) {
        void createMeetingLlmResult(id).catch((error) => {
          console.error("Failed to generate finalized meeting LLM result:", error);
        });
      }

      // fix-261123-04 验收 X2：所有副作用（追加 + 标题 + 状态 + finalize 的 LLM 触发）都排完之后，
      // 才把幂等键标记完成——并发重放会等 key 完成后才拿到 replayed，不会读到半成品会议。
      // 此处 completeIdempotencyKey 在事务外调（不带 tx）；追加本体已在 append 事务内完成。
      if (appendClaimToken && idempotencyKey) {
        await completeIdempotencyKey(idempotencyKey, appendClaimToken, id);
      }

      return NextResponse.json({ meeting });
    } catch (error) {
      // 中途抛错：key 还卡在「进行中」，主动 release 令牌，否则要等到 TTL 才能重试。
      if (appendClaimToken && idempotencyKey) {
        await releaseIdempotencyKey(idempotencyKey, appendClaimToken).catch(() => {});
      }
      if (error instanceof IdempotencyInProgressError || error instanceof IdempotencyConflictError) {
        return NextResponse.json(
          { error: error.message },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update meeting" },
        { status: 400 }
      );
    }
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const deleted = await deleteMeeting(id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  });
}
