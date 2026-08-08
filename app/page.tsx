"use client";

import { useState } from "react";
import { Dashboard } from "@/components/Dashboard";
import { AgentChat } from "@/components/AgentChat";
import { ConsequencePanel } from "@/components/ConsequencePanel";
import { WalletBar } from "@/components/WalletBar";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import type { SimResponse } from "@/lib/simulation";

export default function Home() {
  const [sim, setSim] = useState<SimResponse | null>(null);

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-mist-200">
      <header className="flex shrink-0 items-center justify-between border-b border-ink-700 px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-base font-semibold tracking-tight text-mist-100">
            Monad<span className="text-violet-soft">Lens</span>
          </span>
          <span className="hidden text-[11px] text-mist-400 sm:inline">
            看清网络，看清后果，然后才签字
          </span>
        </div>
        <WalletBar />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-ink-700 lg:grid-cols-[340px_minmax(0,1fr)_380px]">
        <section className="min-h-0 bg-ink-950">
          <PanelErrorBoundary label="实时看板">
            <Dashboard />
          </PanelErrorBoundary>
        </section>
        <section className="min-h-0 border-x border-ink-700 bg-ink-950">
          <PanelErrorBoundary label="对话 Agent">
            <AgentChat onSimulate={setSim} />
          </PanelErrorBoundary>
        </section>
        <section className="min-h-0 bg-ink-950">
          <PanelErrorBoundary label="后果透镜">
            <ConsequencePanel sim={sim} />
          </PanelErrorBoundary>
        </section>
      </main>
    </div>
  );
}
