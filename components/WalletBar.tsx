"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { injected } from "wagmi/connectors";
import { shortAddr, formatAmount } from "@/lib/format";
import { MONAD_CHAIN_ID, MONAD_NETWORK_LABEL, MONAD_ADD_CHAIN_PARAMS, MONAD_FAUCET_URL } from "@/lib/chain";

type NetFeedback = { ok: boolean; msg: string };

export function WalletBar() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address, query: { enabled: Boolean(address) } });
  const { switchChainAsync } = useSwitchChain();
  /** Faucet URL is non-null only on testnet (null on mainnet). */
  const faucet = MONAD_FAUCET_URL;

  const [feedback, setFeedback] = useState<NetFeedback | null>(null);

  // --- Network detection with "trust after switch" strategy ---
  //
  // wagmi's chainId can be unreliable while RPC endpoints flake (stale or
  // undefined mid-reconnect), which makes the "switch" button flicker back in.
  // After a successful explicit switch we TRUST it for 15 s regardless of what
  // wagmi reports, then fall back to wagmi's chainId (with a 2-s debounce).
  const rawOnNetwork = chainId === MONAD_CHAIN_ID;
  const [trustedUntil, setTrustedUntil] = useState(0); // timestamp ms

  const [stableOnNetwork, setStableOnNetwork] = useState(rawOnNetwork);
  const offTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (rawOnNetwork) {
      if (offTimer.current) clearTimeout(offTimer.current);
      setStableOnNetwork(true);
    } else {
      if (!offTimer.current) {
        offTimer.current = setTimeout(() => {
          setStableOnNetwork(false);
          offTimer.current = null;
        }, 2000);
      }
    }
    return () => {
      if (offTimer.current) clearTimeout(offTimer.current);
    };
  }, [rawOnNetwork]);

  const isWithinTrustWindow = Date.now() < trustedUntil;
  const onNetwork = stableOnNetwork || isWithinTrustWindow;

  // Auto-clear feedback after 3 s so the UI doesn't stay stuck on "已切到…"
  const fbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (feedback) {
      fbTimer.current = setTimeout(() => setFeedback(null), 3000);
    }
    return () => {
      if (fbTimer.current) clearTimeout(fbTimer.current);
    };
  }, [feedback]);

  // --- Auto-switch once per browser session ---
  //
  // On refresh the injected connector restores the *account*, but the wallet
  // stays on whatever chain it last had — so every reload landed on
  // "网络不匹配" and demanded a manual "切到 Monad 测试网" click.
  //
  // Guardrails so this never becomes popup spam:
  //   · once per browser *session* (sessionStorage, not per page load) — a
  //     wallet that doesn't remember the per-site chain would otherwise get a
  //     switch request on every single refresh;
  //   · only on a REAL mismatch: an undefined/0 chainId means wagmi is still
  //     mid-reconnect, and switching then can surface a connect popup instead.
  // Failures stay quiet: the amber button + mismatch hint already explain.
  const AUTO_SWITCH_KEY = "monadlens:auto-switch-attempted";
  const chainIdRef = useRef(chainId);
  chainIdRef.current = chainId;
  const autoSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isConnected || !address) return;
    try {
      if (sessionStorage.getItem(AUTO_SWITCH_KEY)) return;
      sessionStorage.setItem(AUTO_SWITCH_KEY, "1");
    } catch {
      // Storage unavailable (private mode etc.) — still attempt, once per mount.
    }
    // Small delay: wagmi's chainId can be stale mid-reconnect.
    autoSwitchTimer.current = setTimeout(() => {
      const cid = chainIdRef.current;
      if (typeof cid === "number" && cid !== MONAD_CHAIN_ID) void ensureNetwork(true);
    }, 1200);
    return () => {
      if (autoSwitchTimer.current) clearTimeout(autoSwitchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  /**
   * Ensure the wallet is on (or has added) the Monad testnet.
   *
   * Routes through wagmi's switchChain so the request goes to the SAME
   * provider the wallet actually connected with. The old raw
   * window.ethereum.request path could hit a different provider when several
   * wallet extensions are installed (MetaMask + OKX both inject), which
   * surfaces as EIP-1193 error 4100 "The requested account and/or method has
   * not been authorized by the user."
   */
  async function ensureNetwork(silent = false) {
    setFeedback(null);
    try {
      await switchChainAsync({ chainId: MONAD_CHAIN_ID });
      setFeedback({ ok: true, msg: `已切到 ${MONAD_NETWORK_LABEL}` });
      setTrustedUntil(Date.now() + 15_000);
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code === 4902) {
        // Chain unknown to the wallet. wagmi's injected connector normally
        // falls back to wallet_addEthereumChain on its own; this is the
        // belt-and-braces path for wallets that don't.
        try {
          const eth = (window as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } })
            .ethereum;
          await eth?.request({ method: "wallet_addEthereumChain", params: [MONAD_ADD_CHAIN_PARAMS] });
          await switchChainAsync({ chainId: MONAD_CHAIN_ID });
          setFeedback({ ok: true, msg: `已添加并切到 ${MONAD_NETWORK_LABEL}` });
          setTrustedUntil(Date.now() + 15_000);
        } catch (e2) {
          const c2 = (e2 as { code?: number })?.code;
          if (!silent) {
            setFeedback({
              ok: false,
              msg: c2 === 4001 ? "你取消了网络添加" : (e2 as { message?: string })?.message ?? "添加网络失败",
            });
          }
        }
        return;
      }
      // Silent (auto) mode: a dismissed switch request stays quiet — the amber
      // button and the mismatch hint below already explain what to do.
      if (!silent) {
        setFeedback({
          ok: false,
          msg: translateSwitchError(e),
        });
      }
    }
  }

  /** Translate raw wallet errors into plain Chinese. */
  function translateSwitchError(e: unknown): string {
    const code = (e as { code?: number })?.code;
    const msg = e instanceof Error ? e.message : String(e ?? "切换网络失败");
    const lower = msg.toLowerCase();
    if (code === 4001 || lower.includes("user rejected") || lower.includes("user denied")) {
      return "你取消了网络切换";
    }
    if (code === 4100 || lower.includes("authorized") || lower.includes("unauthorized")) {
      return "钱包未授权本次切换，请解锁钱包后重试；若仍失败，请断开后重新连接钱包";
    }
    if (lower.includes("unrecognized chain") || lower.includes("recognize")) {
      return "钱包还不认识 Monad 测试网，正在为你添加…请重试一次";
    }
    const firstLine = msg.split("\n")[0].trim();
    return firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine || "切换网络失败";
  }

  /**
   * EIP-3085 wallet_addEthereumChain — used in the DISCONNECTED state.
   *
   * wagmi's switchChain can't help while disconnected: with no connection it
   * never talks to the wallet and only flips local state (see
   * @wagmi/core/actions/switchChain.js), so the chain would never actually
   * land in the wallet. Adding a chain is a wallet-level operation that needs
   * no account authorization, so calling the provider directly is safe — and
   * it is the same window.ethereum that injected() later connects with.
   */
  async function addNetworkToWallet() {
    setFeedback(null);
    const eth = (window as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } })
      .ethereum;
    if (!eth) {
      setFeedback({ ok: false, msg: "未检测到钱包扩展，请先安装 MetaMask / OKX 等" });
      return;
    }
    try {
      await eth.request({ method: "wallet_addEthereumChain", params: [MONAD_ADD_CHAIN_PARAMS] });
      setFeedback({ ok: true, msg: `已把 ${MONAD_NETWORK_LABEL} 添加到钱包` });
    } catch (e) {
      const code = (e as { code?: number })?.code;
      setFeedback({
        ok: false,
        msg:
          code === 4001
            ? "你取消了网络添加"
            : ((e as { message?: string })?.message ?? "添加网络失败"),
      });
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

  // Feedback line: always visible (incl. mobile) and mutually exclusive with the
  // "switch" button — when feedback is showing we hide the button, so an error
  // message and the switch CTA never appear on screen at the same time.
  const feedbackLine = feedback ? (
    <span className={`text-[11px] leading-tight ${feedback.ok ? "text-emerald-300" : "text-rose-300"}`}>
      {feedback.msg}
    </span>
  ) : null;

  if (!isConnected || !address) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => void addNetworkToWallet()}
            title={`把 ${MONAD_NETWORK_LABEL} 一键添加到你的钱包（MetaMask / OKX 等）`}
            className="rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-mist-300 transition-colors hover:border-violet-brand/50 hover:text-violet-soft"
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
        {feedbackLine}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {/* Same slot, mutually exclusive: hide the switch button while feedback
            is on screen, so the error text and the button never overlap. */}
        {!onNetwork && !feedback && (
          <button
            onClick={() => void ensureNetwork()}
            title="把 Monad 测试网添加到钱包并切换过去"
            className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-300 transition-colors hover:bg-amber-400/20"
          >
            切到 {MONAD_NETWORK_LABEL}
          </button>
        )}
        <div className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-850 py-1.5 pl-3 pr-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              onNetwork ? "animate-live bg-emerald-400" : "bg-amber-400"
            }`}
          />
          <span className="tabular text-xs text-mist-200" title="当前钱包余额">
            {balance ? `${formatAmount(balance.value, balance.decimals, 4)} MON` : "—"}
          </span>
          <span className="h-3 w-px bg-ink-600" />
          <span className="font-mono text-xs text-mist-200">{shortAddr(address, 4)}</span>
          <button
            onClick={() => disconnect()}
            title="断开钱包"
            className="ml-0.5 rounded-full border border-ink-600 px-2 py-0.5 text-[10px] text-mist-400 transition-colors hover:border-rose-400/50 hover:text-rose-300"
          >
            断开
          </button>
        </div>
        {faucet && (!balance || balance.value === 0n) && (
          <a
            href={faucet}
            target="_blank"
            rel="noreferrer"
            title={`钱包里没有 MON，去水龙头免费领取测试网 MON：${faucet}`}
            className="flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-300 transition-colors hover:bg-amber-400/20"
          >
            <span aria-hidden>💧</span>领水
          </a>
        )}
      </div>
      {!onNetwork && !feedback && (
        <span className="text-[10px] text-amber-300">网络不匹配，签名前请先切换到 {MONAD_NETWORK_LABEL}</span>
      )}
      {feedbackLine}
    </div>
  );
}
