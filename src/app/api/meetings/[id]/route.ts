import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  deleteMeeting,
  ensureMeetingLlmResult,
  finalizeMeetingSave,
  getMeetingById,
  getMeetingLightById,
  IdempotencyConflictError,
  IdempotencyInProgressError,
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
    try {
      const body = await req.json();

      // 存在性优先：不存在的会议一律 404，不受参数校验影响（与改动前一致，验收 V5）。
      const existing = await getMeetingById(id);
      if (!existing) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      // 参数校验必须放在 finalizeMeetingSave **之前**：无效入参一律 400，与改动前一致，
      // 且现在连一行都不会写（以前无效 status 会先把转写追加进去再返回 400）。
      // 存在性检查已在上方先行（验收 V5：不存在的会议不管参数合法与否都是 404）。
      if (body.status !== undefined && body.status !== "paused" && body.status !== "transcribed") {
        return NextResponse.json({ error: "Unsupported meeting status" }, { status: 400 });
      }
      if (body.status === "transcribed" && body.finalize !== true) {
        return NextResponse.json({ error: "Finalized meetings must set finalize=true" }, { status: 400 });
      }
      if (body.status === undefined && body.finalize === true) {
        return NextResponse.json({ error: "finalize requires status=transcribed" }, { status: 400 });
      }

      // issue #74：保存重试现在**是**幂等的。「追加 + 标题 + 状态」已在 finalizeMeetingSave 里
      // 收进单个事务，幂等键的完成也在同一事务内，所以「已提交但响应丢了」的重试不会重复追加；
      // 前端 stopRecordingInner 与 POST 共用同一个 Idempotency-Key。
      const idempotencyKey = req.headers.get("idempotency-key");
      const outcome = await finalizeMeetingSave({
        meetingId: id,
        appendTranscriptSegments: Array.isArray(body.appendTranscriptSegments) ? body.appendTranscriptSegments : undefined,
        captureSessionId: String(body.captureSessionId ?? `capture-${Date.now()}`),
        captureSessionIds: Array.isArray(body.captureSessionIds) ? body.captureSessionIds : undefined,
        title: body.title,
        status: body.status,
        lastErrorMessage: body.lastErrorMessage ?? null,
        idempotencyKey,
      });
      if (!outcome.meeting) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      // LLM 触发放在事务之后，并且**重放时也要跑**（finalizeMeetingSave 不碰 LLM）：
      // 这样「首次请求已提交但响应丢了」的重试仍能补上生成，而 ensureMeetingLlmResult
      // 自身可重放（已有可用结果 / 有任务在飞就跳过），不会因重试重复生成（issue #74）。
      if (body.finalize === true) {
        void ensureMeetingLlmResult(id).catch((error) => {
          console.error("Failed to generate finalized meeting LLM result:", error);
        });
      }

      return NextResponse.json({ meeting: outcome.meeting });
    } catch (error) {
      // 幂等冲突类错误映射为 409（与 POST /api/meetings 一致）；其余保持原有 400 行为。
      if (error instanceof IdempotencyInProgressError || error instanceof IdempotencyConflictError) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Idempotency conflict" },
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
