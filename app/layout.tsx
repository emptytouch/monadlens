import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "MonadLens — 看清网络，看清后果",
  description:
    "Monad 主网实时看板 + Moss 安全链上 Agent：用对话发起链上操作，在签名之前先看清这笔交易到底会做什么。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
