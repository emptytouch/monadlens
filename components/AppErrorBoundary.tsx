"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Top-level error boundary. Catches any render-time crash in the app shell
 * (Providers, Header, layout-level components) so the user sees a friendly
 * Chinese fallback + reload button instead of a blank white screen.
 *
 * Note: Next.js App Router also supports app/error.tsx / global-error.tsx for
 * segment-level errors; this boundary adds an extra safety net around the
 * whole client tree.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surface for debugging; keep the visible message concise.
    console.error("[AppErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink-900 p-8 text-center">
          <div className="text-lg font-medium text-mist-100">页面出错了</div>
          <p className="max-w-md text-sm leading-relaxed text-mist-400">
            应用程序遇到了意外错误。你可以刷新页面重试；如果问题持续出现，请稍后访问或联系开发团队。
          </p>
          <pre className="max-w-md overflow-auto rounded-lg border border-ink-700 bg-ink-850 p-3 text-left text-[11px] text-rose-300">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-violet-brand px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-deep"
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
