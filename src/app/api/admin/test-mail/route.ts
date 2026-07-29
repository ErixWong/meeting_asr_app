import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      const host = String(body.smtpHost || "");
      const port = Number(body.smtpPort || 465);
      const user = String(body.smtpUsername || "");
      const pass = String(body.smtpPassword || "");

      if (!host || !port) {
        return NextResponse.json({ ok: false, error: "Mail config incomplete" }, { status: 400 });
      }

      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
      });

      await transporter.verify();

      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "Mail test failed" },
        { status: 500 }
      );
    }
  });
}
