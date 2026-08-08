"use client";

import { create } from "zustand";

export type BlockInfo = {
  number: bigint;
  timestamp: number;
  txCount: number;
  gasUsed: bigint;
  gasLimit: bigint;
  baseFeePerGas: bigint | null;
  receivedAt: number;
};

export type TxInfo = {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  blockNumber: bigint;
  receivedAt: number;
};

export type TpsPoint = { t: number; tps: number; gasPct: number; baseFeeGwei: number; blockNumber: number };

export type StreamStatus = "idle" | "connecting" | "live" | "error";

/** Which transport actually delivered the most recent block. */
export type StreamSource = "ws" | "http" | null;

const MAX_BLOCKS = 18;
const MAX_TXS = 24;
const MAX_SERIES = 45;

type State = {
  status: StreamStatus;
  source: StreamSource;
  error: string | null;
  blocks: BlockInfo[];
  txs: TxInfo[];
  series: TpsPoint[];
  pushBlock: (b: BlockInfo) => void;
  pushTxs: (t: TxInfo[]) => void;
  setStatus: (s: StreamStatus, error?: string | null) => void;
  setSource: (s: StreamSource) => void;
};

export const useChainStore = create<State>((set) => ({
  status: "idle",
  source: null,
  error: null,
  blocks: [],
  txs: [],
  series: [],
  setStatus: (status, error = null) => set({ status, error }),
  setSource: (source) => set((s) => (s.source === source ? s : { source })),
  pushBlock: (b) =>
    set((s) => {
      if (s.blocks.some((x) => x.number === b.number)) return s;
      const blocks = [b, ...s.blocks].slice(0, MAX_BLOCKS);
      const prev = s.blocks[0];
      // Block timestamps are second-granularity and can repeat on a sub-second
      // chain, so derive the interval from arrival time when they collide.
      let interval = prev ? b.timestamp - prev.timestamp : 0;
      if (interval <= 0 && prev) interval = (b.receivedAt - prev.receivedAt) / 1000;
      const tps = interval > 0 ? b.txCount / interval : b.txCount;
      const gasPct = b.gasLimit > 0n ? Number((b.gasUsed * 10000n) / b.gasLimit) / 100 : 0;
      const point: TpsPoint = {
        t: b.receivedAt,
        tps: Number.isFinite(tps) ? Math.round(tps * 10) / 10 : 0,
        gasPct: Math.round(gasPct * 10) / 10,
        baseFeeGwei: b.baseFeePerGas ? Number(b.baseFeePerGas) / 1e9 : 0,
        blockNumber: Number(b.number),
      };
      return { blocks, series: [...s.series, point].slice(-MAX_SERIES) };
    }),
  pushTxs: (incoming) =>
    set((s) => {
      if (incoming.length === 0) return s;
      const seen = new Set(s.txs.map((t) => t.hash));
      const fresh = incoming.filter((t) => !seen.has(t.hash));
      if (fresh.length === 0) return s;
      return { txs: [...fresh, ...s.txs].slice(0, MAX_TXS) };
    }),
}));

/** Rolling network metrics derived from the block window. */
export function selectMetrics(s: State) {
  const { blocks } = s;
  const latest = blocks[0];
  if (!latest) {
    return { tps: 0, blockTime: 0, gasPct: 0, baseFeeGwei: 0, latest: null, txWindow: 0 };
  }
  const window = blocks.slice(0, 10);
  const oldest = window[window.length - 1];
  const spanMs = window.length > 1 ? latest.receivedAt - oldest.receivedAt : 0;
  const txWindow = window.reduce((acc, b) => acc + b.txCount, 0);
  const tps = spanMs > 0 ? (txWindow / spanMs) * 1000 : 0;
  const blockTime = window.length > 1 ? spanMs / (window.length - 1) / 1000 : 0;
  const gasPct = latest.gasLimit > 0n ? Number((latest.gasUsed * 10000n) / latest.gasLimit) / 100 : 0;
  const baseFeeGwei = latest.baseFeePerGas ? Number(latest.baseFeePerGas) / 1e9 : 0;
  return { tps, blockTime, gasPct, baseFeeGwei, latest, txWindow };
}
