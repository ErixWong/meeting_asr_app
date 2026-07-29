import type { Metadata } from "next";
import SessionNav from "@/components/auth/SessionNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "智能会议纪要系统",
  description: "基于 FunASR 与 Qwen 的智能会议纪要应用",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <SessionNav />
        {children}
      </body>
    </html>
  );
}
