"use client";

import { useRef, useState } from "react";
import { Dashboard } from "@/components/Dashboard";
import { AgentChat } from "@/components/AgentChat";
import { ConsequencePanel } from "@/components/ConsequencePanel";
import { WalletBar } from "@/components/WalletBar";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import type { SimResponse } from "@/lib/simulation";

export default function Home() {
  const [sim, setSim] = useState<SimResponse | null>(null);

  // Hashes the user actually broadcast. Shared with the dashboard so a signed
  // tx shows up highlighted in the live feed — the moment the consequence
  // lens promises "this is what will happen" and then it visibly happens.
  const [sentHashes, setSentHashes] = useState<string[]>([]);

  // "Who is this address?" handed from the dashboard to the agent. Wrapped with
  // a seq counter so clicking the same address twice still re-triggers.
  const [inspect, setInspect] = useState<{ text: string; seq: number } | null>(null);
  const inspectSeq = useRef(0);
  const inspectAddress = (addr: string) => {
    inspectSeq.current += 1;
    setInspect({ text: `查一下这个地址 ${addr}`, seq: inspectSeq.current });
  };

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-mist-200">
      <header className="flex shrink-0 items-center justify-between border-b border-ink-700 bg-ink-900/50 px-5 py-3 backdrop-blur">
        <div className="flex items-baseline gap-3">
          <span className="text-base font-semibold tracking-tight text-mist-100">
            Monad
            <span className="bg-gradient-to-r from-violet-soft to-violet-brand bg-clip-text text-transparent">
              Lens
            </span>
            <span className="ml-2 text-xs font-normal text-mist-400">· 透视链</span>
          </span>
          <span className="hidden text-[11px] text-mist-400 sm:inline">
            看清网络，看清后果，然后才签字
          </span>
        </div>
        <WalletBar />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[340px_minmax(0,1fr)_390px]">
        <section className="min-h-0 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900/60 shadow-panel">
          <PanelErrorBoundary label="实时看板">
            <Dashboard sentHashes={sentHashes} onInspectAddress={inspectAddress} />
          </PanelErrorBoundary>
        </section>
        <section className="min-h-0 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900/60 shadow-panel">
          <PanelErrorBoundary label="对话 Agent">
            <AgentChat onSimulate={setSim} pendingQuery={inspect} />
          </PanelErrorBoundary>
        </section>
        <section className="min-h-0 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900/60 shadow-panel">
          <PanelErrorBoundary label="后果透镜">
            <ConsequencePanel
              sim={sim}
              onSent={(hashes) => setSentHashes((prev) => [...new Set([...prev, ...hashes])])}
            />
          </PanelErrorBoundary>
        </section>
      </main>
    </div>
  );
}
