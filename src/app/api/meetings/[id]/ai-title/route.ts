import { NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { generateMeetingTitle } from "@/lib/admin-store";
import { AiTitleError } from "@/lib/ai-title";

export const dynamic = "force-dynamic";

/**
 * 会议 AI 标题（feat-261101-04 / GitHub #44）
 *
 * POST /api/meetings/[id]/ai-title
 *   → 用 LLM 根据转写生成标题并**直接重命名**该会议
 *   → 返回 `{ ok, title, previousTitle, meeting }`；`meeting` 是**与列表/详情同一个投影函数**
 *     产出的对象，前端拿它同时刷新列表行与详情（避免「详情有、列表没有」）。
 *
 * 鉴权与既有会议接口一致（BUSINESS_ROLES：401 未登录 / 403 无权限 / 404 会议不存在或非本人）。
 * 不做预览确认（用户已确认语义），撤销由前端 toast 提供一次。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const result = await generateMeetingTitle(id);
      return NextResponse.json({
        ok: true,
        title: result.title,
        previousTitle: result.previousTitle,
        meeting: result.meeting,
        llmResultId: result.llmResultId,
        transcriptChars: result.transcriptChars,
        sentChars: result.sentChars,
        truncated: result.truncated,
      });
    } catch (error) {
      const status = error instanceof AiTitleError ? error.status : 500;
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to generate ai title" },
        { status }
      );
    }
  });
}
