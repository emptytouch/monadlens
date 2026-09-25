import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { MONAD_NETWORK_LABEL } from "@/lib/chain";

export const metadata: Metadata = {
  title: "MonadLens · 透视链 — 看清网络，看清后果",
  // Network is chosen at build time; a hardcoded "主网" here would misdescribe
  // the tab / share preview whenever the app is built for testnet.
  description: `Monad ${MONAD_NETWORK_LABEL}实时看板 + Moss 安全链上 Agent：用对话发起链上操作，在签名之前先看清这笔交易到底会做什么。`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <AppErrorBoundary>
          <Providers>{children}</Providers>
        </AppErrorBoundary>
      </body>
    </html>
  );
}
