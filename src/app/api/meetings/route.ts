import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  createMeetingWithOutcome,
  createMeetingLlmResult,
  listMeetings,
  IdempotencyInProgressError,
  IdempotencyConflictError,
} from "@/lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
  return NextResponse.json({ meetings: await listMeetings() });
  });
}

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
  try {
      const body = await req.json();
      // fix-261123-04（issue #74-3）：只透传幂等键，去重逻辑在 createMeeting 里。
      const idempotencyKey = req.headers.get("idempotency-key");
      const outcome = await createMeetingWithOutcome({
        title: body.title,
        sourceType: body.sourceType,
        sourceFileName: body.sourceFileName ?? null,
        durationSeconds: body.durationSeconds ?? null,
        captureSessionId: body.captureSessionId ?? `capture-${Date.now()}`,
        // feat-261101-01：双通道会传两个 session id；单数 captureSessionId 继续兼容
        captureSessionIds: Array.isArray(body.captureSessionIds) ? body.captureSessionIds : undefined,
        transcriptSegments: body.transcriptSegments ?? [],
        idempotencyKey,
      });
      const meeting = outcome.meeting;

      let defaultLlmResult: { triggered: boolean; status: string; error?: string } = {
        triggered: false,
        status: "skipped",
      };

      // 幂等命中时副作用没有重新执行，不能再触发一次 LLM 生成（验收 V1/V8）。
      // 下方主条件的 `!outcome.replayed` 前置受 idempotency-test 的源码结构守卫保护，删掉它应让守卫变红。
      if (!outcome.replayed && meeting?.id && body.triggerLlm !== false) {
        defaultLlmResult = { triggered: true, status: "pending" };
        void createMeetingLlmResult(meeting.id).catch((error) => {
          console.error("Failed to generate default LLM result:", error);
        });
      } else if (outcome.replayed) {
        defaultLlmResult = { triggered: false, status: "replayed" };
      }

      return NextResponse.json({ meeting, defaultLlmResult });
    } catch (error) {
      if (error instanceof IdempotencyInProgressError || error instanceof IdempotencyConflictError) {
        return NextResponse.json(
          { error: error.message },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create meeting" },
        { status: 400 }
      );
    }
  });
}
