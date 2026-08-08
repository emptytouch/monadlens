"use client";

import { Component, type ReactNode } from "react";

interface Props { children: ReactNode; label: string; }
interface State { error: Error | null; info: React.ErrorInfo | null; }

/**
 * Lightweight per-section error boundary for ConsequencePanel.
 * Each wrapped section fails independently — the rest of the panel keeps rendering.
 */
export class SectionBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, info });
    console.warn(`[SectionBoundary:${this.props.label}]`, error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-rose-400/30 bg-rose-400/5 px-3 py-2">
          <div className="text-[11px] font-medium text-rose-300">
            {this.props.label} 渲染异常
          </div>
          <button
            onClick={() => this.setState({ error: null, info: null })}
            className="mt-1 text-[10px] text-mist-400 underline hover:text-mist-200"
          >
            重试
          </button>
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] text-mist-500">技术详情</summary>
            <pre className="mt-1 max-h-32 overflow-auto text-[9px] text-mist-500">
              {String(this.state.error?.message ?? "")}
              {"\n"}
              {this.state.info?.componentStack ?? ""}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
