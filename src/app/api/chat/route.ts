import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ROLES, withRequiredRoles } from "@/lib/api-auth";
import {
  createConversation,
  deleteConversation,
  getConversation,
  runChatStream,
} from "@/lib/chat-store";

export const dynamic = "force-dynamic";

const MAX_MESSAGE_CHARS = 2000;

function sseEvent(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// 流式：SSE（event: delta / done / error）；非流式：完整 JSON。
// body: { message, conversationId?, stream? }
export async function POST(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const message = String(body.message ?? "").trim();
      const stream = Boolean(body.stream);
      const conversationId = body.conversationId ? String(body.conversationId) : "";

      if (!message) {
        return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
      }
      if (message.length > MAX_MESSAGE_CHARS) {
        return NextResponse.json({ error: `消息过长（上限 ${MAX_MESSAGE_CHARS} 字）` }, { status: 400 });
      }

      // 会话管理：无 id → 新建；有 id → 校验存在
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        activeConversationId = createConversation();
      } else if (!getConversation(activeConversationId)) {
        return NextResponse.json({ error: "会话不存在或已过期" }, { status: 404 });
      }

      if (!stream) {
        let content = "";
        let finishReason = "stop";
        await runChatStream(activeConversationId, message, {
          onDelta: (text) => { content += text; },
          onDone: (_content, reason) => { content = _content; finishReason = reason; },
          onError: () => {},
        });
        return NextResponse.json({
          conversationId: activeConversationId,
          text: content,
          finishReason,
        });
      }

      // 流式：SSE 边生成边返回；runChatStream 在队列中串行执行，
      // onDelta 在队列 worker 线程/事件循环中同步回调，直接写响应流。
      const encoder = new TextEncoder();
      const responseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent("start", { conversationId: activeConversationId })));

          let finished = false;
          runChatStream(activeConversationId, message, {
            onDelta: (text) => {
              if (!finished) controller.enqueue(encoder.encode(sseEvent("delta", { text })));
            },
            onDone: (_content, finishReason) => {
              if (finished) return;
              finished = true;
              controller.enqueue(encoder.encode(sseEvent("done", { text: _content, finishReason })));
              controller.close();
            },
            onError: (error) => {
              if (finished) return;
              finished = true;
              controller.enqueue(encoder.encode(sseEvent("error", { error: error.message })));
              controller.close();
            },
          }).catch((error) => {
            if (!finished) {
              finished = true;
              controller.enqueue(encoder.encode(sseEvent("error", {
                error: error instanceof Error ? error.message : String(error),
              })));
              controller.close();
            }
          });
        },
        cancel() {
          // 客户端断开：runChatStream 内部 AbortController 由 timeout 控制；
          // V1 不做主动取消（队列任务会自然完成/超时）。
        },
      });

      return new Response(responseStream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "对话失败";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}

// DELETE /api/chat?conversationId=xxx —— 清空会话（释放内存）
export async function DELETE(req: NextRequest) {
  return withRequiredRoles(req, BUSINESS_ROLES, async () => {
    const conversationId = new URL(req.url).searchParams.get("conversationId");
    if (!conversationId) {
      return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
    }
    deleteConversation(conversationId);
    return NextResponse.json({ ok: true });
  });
}
