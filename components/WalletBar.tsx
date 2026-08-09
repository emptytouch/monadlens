"use client";

import { useState } from "react";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { shortAddr, formatAmount } from "@/lib/format";
import { MONAD_CHAIN_ID, MONAD_NETWORK_LABEL, MONAD_ADD_CHAIN_PARAMS, MONAD_CHAIN_ID_HEX } from "@/lib/chain";

type NetFeedback = { ok: boolean; msg: string };

export function WalletBar() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address, query: { enabled: Boolean(address) } });

  const [feedback, setFeedback] = useState<NetFeedback | null>(null);

  const onNetwork = chainId === MONAD_CHAIN_ID;

  /**
   * Ensure the wallet is on (or has added) the Monad network.
   * Strategy: try wallet_switchEthereumChain first; if the chain is unknown to
   * the wallet (error code 4902) fall back to wallet_addEthereumChain. This
   * makes a single button work whether the network is already saved or not.
   */
  async function ensureNetwork() {
    setFeedback(null);
    const eth = (window as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum;
    if (!eth?.request) {
      setFeedback({ ok: false, msg: "未检测到钱包扩展，请先安装 MetaMask / OKX 等" });
      return;
    }
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: MONAD_CHAIN_ID_HEX }],
      });
      setFeedback({ ok: true, msg: `已切到 ${MONAD_NETWORK_LABEL}` });
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code === 4902) {
        try {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [MONAD_ADD_CHAIN_PARAMS],
          });
          setFeedback({ ok: true, msg: `已添加并切到 ${MONAD_NETWORK_LABEL}` });
        } catch (e2) {
          const c2 = (e2 as { code?: number })?.code;
          setFeedback({
            ok: false,
            msg: c2 === 4001 ? "你取消了网络添加" : (e2 as { message?: string })?.message ?? "添加网络失败",
          });
        }
      } else if (code === 4001) {
        setFeedback({ ok: false, msg: "你取消了网络切换" });
      } else {
        setFeedback({ ok: false, msg: (e as { message?: string })?.message ?? "切换网络失败" });
      }
    }
  }

  /** Connect with a friendly error path: detect a missing wallet extension
   *  before calling connect, and translate a user rejection (4001). */
  async function handleConnect() {
    const eth = (window as unknown as { ethereum?: unknown }).ethereum;
    if (!eth) {
      setFeedback({ ok: false, msg: "未检测到钱包扩展，请先安装 MetaMask / OKX 等" });
      return;
    }
    connect(
      { connector: injected() },
      {
        onError: (e: unknown) => {
          const code = (e as { code?: number })?.code;
          setFeedback({
            ok: false,
            msg:
              code === 4001
                ? "你取消了钱包连接"
                : ((e as { message?: string })?.message ?? "连接失败，请重试"),
          });
        },
      },
    );
  }

  if (!isConnected || !address) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <button
            onClick={ensureNetwork}
            title="把 Monad 网络一键添加到你的钱包（MetaMask / OKX 等）"
            className="rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-mist-400 transition-colors hover:border-violet-brand/50 hover:text-violet-soft"
          >
            添加网络
          </button>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="rounded-full border border-violet-deep bg-violet-brand/15 px-4 py-1.5 text-xs font-medium text-violet-soft transition-colors hover:bg-violet-brand/25 disabled:opacity-50"
          >
            {connecting ? "连接中…" : "连接钱包"}
          </button>
        </div>
        {feedback && (
          <span className={`text-[10px] ${feedback.ok ? "text-emerald-400" : "text-amber-400"}`}>
            {feedback.msg}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden flex-col items-end sm:flex">
        <span className="tabular text-xs text-mist-200">
          {balance ? `${formatAmount(balance.value, balance.decimals, 4)} MON` : "—"}
        </span>
        <span className={`text-[10px] ${onNetwork ? "text-emerald-400" : "text-mist-500"}`}>
          {onNetwork ? MONAD_NETWORK_LABEL : "网络不匹配"}
        </span>
        {feedback && (
          <span className={`text-[10px] ${feedback.ok ? "text-emerald-400" : "text-amber-400"}`}>
            {feedback.msg}
          </span>
        )}
      </div>
      {!onNetwork && (
        <button
          onClick={ensureNetwork}
          title="把 Monad 网络添加到钱包并切换过去"
          className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-300 transition-colors hover:bg-amber-400/20"
        >
          切到 {MONAD_NETWORK_LABEL}
        </button>
      )}
      <div className="flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span className="font-mono text-xs text-mist-200">{shortAddr(address, 4)}</span>
      </div>
      <button
        onClick={() => disconnect()}
        className="rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-mist-400 transition-colors hover:border-rose-400/50 hover:text-rose-300"
      >
        断开
      </button>
    </div>
  );
}
