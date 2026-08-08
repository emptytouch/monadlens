"use client";

import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  /** Label shown in the fallback so you know which panel crashed. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches rendering errors in one panel without crashing the whole page.
 * In production builds React minifies errors to codes (e.g. #130);
 * this boundary preserves the rest of the UI.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[PanelErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="text-sm text-mist-300">面板渲染异常</div>
          <p className="max-w-xs text-[11px] leading-relaxed text-mist-400">
            {this.props.label ?? "此区域"} 遇到了一个渲染错误。这通常不影响其他面板。
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-mist-300 transition-colors hover:border-violet-deep"
          >
            重试
          </button>
          <details className="w-full max-w-xs cursor-text text-left">
            <summary className="text-[10px] text-mist-500">技术详情</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-mist-500">{this.state.error.message}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
