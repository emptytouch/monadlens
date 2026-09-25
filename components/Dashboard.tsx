"use client";

import { useEffect, useMemo, useState } from "react";
import { useChainStore, selectMetrics } from "@/lib/store";
import { useMonadStream } from "@/lib/useMonadStream";
import { TpsChart } from "./TpsChart";
import { GasChart } from "./GasChart";
import { formatAmount, formatNumber, shortAddr } from "@/lib/format";
import { explorerBlock, explorerTx, explorerAddress, MONAD_CHAIN_ID, MONAD_NETWORK_LABEL } from "@/lib/chain";

function StatusDot({ status, source }: { status: string; source: string | null }) {
  const map: Record<string, { color: string; label: string; pulse: boolean }> = {
    live: { color: "bg-emerald-400", label: "实时", pulse: true },
    connecting: { color: "bg-amber-400", label: "连接中", pulse: true },
    error: { color: "bg-rose-400", label: "异常", pulse: false },
    idle: { color: "bg-mist-400", label: "待机", pulse: false },
  };
  const s = map[status] ?? map.idle;
  // Showing the transport makes a degraded-but-working stream legible.
  const via = status === "live" && source ? (source === "ws" ? " · WS" : " · 轮询") : "";
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-mist-400">
      <span className={`h-1.5 w-1.5 rounded-full ${s.color} ${s.pulse ? "animate-live" : ""}`} />
      {s.label}
      {via}
    </span>
  );
}

/** Public RPC handshakes can run past 10s; silence reads as a hang. */
function ConnectingHint({ seconds }: { seconds: number }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 px-3 py-3 text-center">
      <div className="text-[11px] text-mist-300">正在连接 {MONAD_NETWORK_LABEL} 公共节点…</div>
      <div className="mt-1 text-[10px] text-mist-400">
        已等待 {seconds}s{seconds >= 8 && " · 公共节点响应较慢，WebSocket 与轮询正在并行尝试"}
      </div>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-3 py-2.5">
      <div className="text-[11px] text-mist-400">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="tabular text-lg font-medium text-mist-200">{value}</span>
        {unit && <span className="text-[11px] text-mist-400">{unit}</span>}
      </div>
    </div>
  );
}

export function Dashboard({
  sentHashes = [],
  onInspectAddress,
}: {
  /** Tx hashes the user broadcast in this session — highlighted in the feed. */
  sentHashes?: string[];
  /** Hand an address to the agent ("who is this?") instead of only linking out. */
  onInspectAddress?: (addr: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const status = useChainStore((s) => s.status);
  const source = useChainStore((s) => s.source);
  const blocks = useChainStore((s) => s.blocks);
  const txs = useChainStore((s) => s.txs);
  const series = useChainStore((s) => s.series);
  // Derive metrics from primitives via useMemo so selectMetrics (which returns
  // a new object each call) never hits React 19's getServerSnapshot during SSR.
  const _metrics = useMemo(() => selectMetrics({ status, source, error: null, blocks, txs, series } as Parameters<typeof selectMetrics>[0]), [blocks, series]);
  const metrics = _metrics ?? { tps: 0, blockTime: 0, gasPct: 0, baseFeeGwei: 0, latest: null, txWindow: 0 };

  // Busiest addresses/contracts from the live tx feed — a quick "who's active".
  const mineSet = useMemo(
    () => new Set(sentHashes.map((h) => h.toLowerCase())),
    [sentHashes],
  );

  // Broadcast but not yet seen in a block. Without this the dashboard looks
  // completely unchanged for the seconds between signing and the tx landing in
  // a block, which reads as "the highlight didn't work".
  const pendingMine = useMemo(
    () => sentHashes.filter((h) => !txs.some((t) => t.hash.toLowerCase() === h.toLowerCase())),
    [sentHashes, txs],
  );

  // Poll faster while one of the user's own broadcasts is still pending.
  useMonadStream(pendingMine);

  const activity = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tx of txs) {
      if (tx.from) counts.set(tx.from, (counts.get(tx.from) ?? 0) + 1);
      if (tx.to) counts.set(tx.to, (counts.get(tx.to) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [txs]);

  // Tick a visible counter while connecting (initial connect OR stream drop),
  // so a slow / intermittent RPC never looks frozen.
  const [waited, setWaited] = useState(0);
  const connecting = mounted && status === "connecting";
  useEffect(() => {
    if (!connecting) return;
    const id = setInterval(() => setWaited((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [connecting]);

  if (!mounted) {
    return <div className="p-4 text-xs text-mist-400">正在连接 {MONAD_NETWORK_LABEL}…</div>;
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-mist-200">网络正在发生什么</h2>
          <p className="text-[11px] text-mist-400">
            {MONAD_NETWORK_LABEL} · chainId {MONAD_CHAIN_ID}
          </p>
        </div>
        <StatusDot status={status} source={source} />
      </div>

      {status === "connecting" && <ConnectingHint seconds={waited} />}

      <div className="grid grid-cols-2 gap-2">
        <Stat label="吞吐" value={formatNumber(metrics.tps, 1)} unit="tx/s" />
        <Stat label="出块间隔" value={metrics.blockTime ? metrics.blockTime.toFixed(2) : "—"} unit="秒" />
        <Stat label="区块 Gas 占用" value={metrics.gasPct.toFixed(1)} unit="%" />
        <Stat label="基础费" value={metrics.baseFeeGwei.toFixed(1)} unit="gwei" />
      </div>

      <div className="rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-mist-400">实时吞吐</span>
          <span className="tabular text-[11px] text-mist-400">
            {metrics.latest ? `#${metrics.latest.number.toString()}` : "—"}
          </span>
        </div>
        <TpsChart series={series} />
      </div>

      <div className="rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-mist-400">Gas 基础费趋势</span>
          <span className="tabular text-[11px] text-mist-400">
            {metrics.baseFeeGwei.toFixed(2)} gwei
          </span>
        </div>
        <GasChart series={series} />
      </div>

      <section>
        <h3 className="mb-1.5 text-[11px] text-mist-400">最新区块</h3>
        <div className="space-y-1">
          {blocks.slice(0, 6).map((b) => (
            <a
              key={b.number.toString()}
              href={explorerBlock(b.number)}
              target="_blank"
              rel="noreferrer"
              className="animate-row-in flex items-center justify-between rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs transition-colors hover:border-violet-deep"
            >
              <span className="tabular text-violet-soft">#{b.number.toString()}</span>
              <span className="tabular text-mist-400">{b.txCount} 笔</span>
              <span className="tabular text-mist-400">
                {b.gasLimit > 0n
                  ? `${(Number((b.gasUsed * 10000n) / b.gasLimit) / 100).toFixed(1)}%`
                  : "—"}
              </span>
            </a>
          ))}
          {blocks.length === 0 && (
            <div className="rounded-md border border-dashed border-ink-700 px-2.5 py-3 text-center text-[11px] text-mist-400">
              等待第一个区块…
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 flex items-center justify-between text-[11px] text-mist-400">
          <span>最近交易对手（实时）</span>
          <span className="text-[10px] text-mist-500">点地址交给 Agent 查身份</span>
        </h3>
        <div className="space-y-1">
          {activity.map(([addr, count]) => (
            <div
              key={addr}
              className="flex items-center justify-between gap-2 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 font-mono text-[11px] transition-colors hover:border-violet-deep"
            >
              <button
                onClick={() => onInspectAddress?.(addr)}
                title={`让 Agent 查一下 ${addr}`}
                className="min-w-0 flex-1 truncate text-left text-mist-300 transition-colors hover:text-violet-soft"
              >
                {shortAddr(addr, 6)}
              </button>
              <span className="tabular text-violet-soft">{count} 笔</span>
              <a
                href={explorerAddress(addr)}
                target="_blank"
                rel="noreferrer"
                title="在区块浏览器打开"
                className="text-[10px] text-mist-500 transition-colors hover:text-mist-200"
              >
                ↗
              </a>
            </div>
          ))}
          {activity.length === 0 && (
            <div className="rounded-md border border-dashed border-ink-700 px-2.5 py-3 text-center text-[11px] text-mist-400">
              等待交易活动…
            </div>
          )}
          {activity.length > 0 && (
            <p className="text-[10px] leading-relaxed text-mist-500">
              统计口径：最近 {txs.length} 笔交易（窗口上限 24 笔），不是全链排行。
            </p>
          )}
        </div>
      </section>

      <section className="min-h-0 flex-1">
        <h3 className="mb-1.5 text-[11px] text-mist-400">实时交易</h3>
        <div className="space-y-1">
          {pendingMine.map((h) => (
            <a
              key={h}
              href={explorerTx(h)}
              target="_blank"
              rel="noreferrer"
              className="animate-row-in flex items-center justify-between gap-2 rounded-md border border-violet-brand/50 bg-violet-brand/10 px-2.5 py-1.5 font-mono text-[11px] transition-colors hover:border-violet-brand"
            >
              <span className="text-violet-soft">{shortAddr(h, 6)}</span>
              <span className="rounded bg-violet-brand/25 px-1.5 py-0.5 text-[9px] font-sans text-violet-soft">
                你已广播 · 等待上链
              </span>
              <span className="text-[10px] text-mist-400">↗</span>
            </a>
          ))}
          {txs.slice(0, 10).map((tx) => {
            // A tx the user just signed here: make it unmistakable in the feed.
            const mine = mineSet.has(tx.hash.toLowerCase());
            return (
              <a
                key={tx.hash}
                href={explorerTx(tx.hash)}
                target="_blank"
                rel="noreferrer"
                className={`animate-row-in flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition-colors hover:border-violet-deep ${
                  mine
                    ? "border-violet-brand/60 bg-violet-brand/10 shadow-glow"
                    : "border-ink-700 bg-ink-850"
                }`}
              >
                <span className={mine ? "text-violet-soft" : "text-mist-400"}>
                  {shortAddr(tx.from, 4)}
                </span>
                <span className="text-ink-600">→</span>
                <span className={mine ? "text-violet-soft" : "text-mist-400"}>
                  {tx.to ? shortAddr(tx.to, 4) : "合约创建"}
                </span>
                {mine && (
                  <span className="rounded bg-violet-brand/25 px-1.5 py-0.5 text-[9px] font-sans text-violet-soft">
                    你签名广播
                  </span>
                )}
                <span className={`tabular ml-auto ${mine ? "text-violet-soft" : "text-violet-soft"}`}>
                  {tx.value > 0n ? `${formatAmount(tx.value, 18, 3)} MON` : "—"}
                </span>
              </a>
            );
          })}
          {txs.length === 0 && (
            <div className="rounded-md border border-dashed border-ink-700 px-2.5 py-3 text-center text-[11px] text-mist-400">
              等待交易…
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
