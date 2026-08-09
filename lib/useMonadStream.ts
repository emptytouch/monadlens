"use client";

import { useEffect } from "react";
import { createPublicClient, webSocket, http, fallback, type Block } from "viem";
import { monad, MONAD_RPC_WS_LIST, MONAD_RPC_HTTP_LIST } from "./chain";
import { useChainStore, type BlockInfo, type TxInfo } from "./store";

type FullBlock = Block<bigint, true>;

/** Treat the socket as healthy if it delivered anything this recently. */
const WS_FRESH_MS = 6_000;
/** Gap between polls once the socket is carrying the stream. */
const POLL_IDLE_MS = 8_000;
/** Gap between polls while the socket is still silent. */
const POLL_ACTIVE_MS = 1_500;

function toBlockInfo(block: FullBlock): BlockInfo {
  return {
    number: block.number ?? 0n,
    timestamp: Number(block.timestamp),
    txCount: block.transactions.length,
    gasUsed: block.gasUsed,
    gasLimit: block.gasLimit,
    baseFeePerGas: block.baseFeePerGas ?? null,
    receivedAt: Date.now(),
  };
}

function toTxInfos(block: FullBlock): TxInfo[] {
  const now = Date.now();
  return block.transactions.slice(0, 8).map((tx) => ({
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    blockNumber: block.number ?? 0n,
    receivedAt: now,
  }));
}

/**
 * Streams Monad mainnet head blocks.
 *
 * WebSocket and HTTP race rather than relay. Public RPC handshakes can take
 * >10s from some networks, and the old "wait 8s, then fall back" design was
 * the worst of both worlds: it killed a socket that was about to deliver, then
 * started polling from scratch. Now both start immediately, whichever arrives
 * first paints the UI, and polling backs off once the socket proves healthy.
 *
 * Polling is self-scheduling (never setInterval): a fixed interval shorter than
 * the request latency stacks requests on top of each other and melts the RPC.
 */
export function useMonadStream() {
  useEffect(() => {
    const { pushBlock, pushTxs, setStatus, setSource } = useChainStore.getState();
    let disposed = false;
    let unwatch: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let lastWsAt = 0;
    let highest = 0n;

    let lastBlockAt = 0;
    /** Ignore blocks we've already rendered, whichever transport wins. */
    const accept = (block: FullBlock, from: "ws" | "http") => {
      if (disposed) return;
      const n = block.number ?? 0n;
      if (n <= highest) return;
      highest = n;
      if (from === "ws") lastWsAt = Date.now();
      lastBlockAt = Date.now();
      setStatus("live");
      setSource(from);
      pushBlock(toBlockInfo(block));
      pushTxs(toTxInfos(block));
    };

    // Watchdog: if the stream goes silent (socket dropped AND polling also
    // failing) while we already had data, downgrade from "live" so the UI stops
    // showing stale numbers as if they were current.
    const watchdog = setInterval(() => {
      if (disposed) return;
      const st = useChainStore.getState();
      if (st.status === "live" && lastBlockAt && Date.now() - lastBlockAt > 15000) {
        setStatus("connecting");
      }
    }, 5000);

    setStatus("connecting");

    // --- transport A: websocket subscription (race all endpoints) ---------
    const unwatchFns: Array<() => void> = [];
    for (const wsUrl of MONAD_RPC_WS_LIST) {
      try {
        const wsClient = createPublicClient({
          chain: monad,
          transport: webSocket(wsUrl, {
            reconnect: { attempts: 10, delay: 1500 },
            retryCount: 3,
            timeout: 20_000,
          }),
        });
        const u = wsClient.watchBlocks({
          includeTransactions: true,
          emitOnBegin: true,
          onBlock: (block) => accept(block as FullBlock, "ws"),
          // A socket error is not fatal — polling is already running underneath.
          onError: (err) => {
            if (!disposed && useChainStore.getState().blocks.length === 0) {
              setStatus("connecting", err.message);
            }
          },
        });
        unwatchFns.push(u);
      } catch {
        // This socket unavailable; try the next endpoint / polling carries.
      }
    }
    unwatch = () => unwatchFns.forEach((fn) => fn());

    // --- transport B: adaptive polling -------------------------------------
    const httpClient = createPublicClient({
      chain: monad,
      transport: fallback(MONAD_RPC_HTTP_LIST.map((u) => http(u))),
    });

    const poll = async () => {
      if (disposed) return;
      const socketHealthy = Date.now() - lastWsAt < WS_FRESH_MS;
      if (!socketHealthy) {
        try {
          const block = (await httpClient.getBlock({
            blockTag: "latest",
            includeTransactions: true,
          })) as FullBlock;
          accept(block, "http");
        } catch (err) {
          if (!disposed && useChainStore.getState().blocks.length === 0) {
            setStatus("error", err instanceof Error ? err.message : "RPC 无响应");
          }
        }
      }
      if (disposed) return;
      // Schedule only after the previous request settled: no pile-up.
      const next = Date.now() - lastWsAt < WS_FRESH_MS ? POLL_IDLE_MS : POLL_ACTIVE_MS;
      pollTimer = setTimeout(poll, next);
    };
    void poll();

    return () => {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      clearInterval(watchdog);
      unwatch?.();
    };
  }, []);
}
