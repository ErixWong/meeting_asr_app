import type { Metadata } from "next";
import AppHeader from "@/components/layout/AppHeader";
import { TtsProvider } from "@/components/tts/TtsProvider";
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
      <body className="min-h-screen bg-slate-50">
        <TtsProvider>
          <div className="flex h-screen flex-col">
            <AppHeader />
            {children}
          </div>
        </TtsProvider>
      </body>
    </html>
  );
}
