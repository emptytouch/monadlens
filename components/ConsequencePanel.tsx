"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, useSendTransaction, useSwitchChain } from "wagmi";
import type { SimResponse, SimSuccess } from "@/lib/simulation";
import { WARNING_COPY } from "@/lib/simulation";
import { MONAD_CHAIN_ID, MONAD_IS_TESTNET, explorerTx, tokenFromRef } from "@/lib/chain";
import { formatAmount, formatApproval, shortAddr } from "@/lib/format";
import { SectionBoundary } from "./SectionBoundary";

/* ── tiny presentational helpers ─────────────────────────────── */

function tokenLabel(ref: string): string {
  try {
    if (ref === "native") return "MON";
    const meta = tokenFromRef(ref);
    return meta?.symbol ?? ref.slice(0, 8);
  } catch {
    return ref.slice(0, 8);
  }
}

function safeDecimals(ref: string): number {
  try {
    return ref === "native" ? 18 : tokenFromRef(ref)?.decimals ?? 18;
  } catch {
    return 18;
  }
}

function TokenAmount({ ref, amount }: { ref: string; amount: string }) {
  const dec = safeDecimals(ref);
  return (
    <span className="tabular">
      {formatAmount(amount, dec, 6)}{" "}
      <span className="text-mist-400">{tokenLabel(ref)}</span>
    </span>
  );
}

function VerdictBanner({ verdict, reverted }: { verdict: string; reverted: boolean }) {
  const map = {
    safe: {
      cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
      text: reverted ? "模拟回滚 · 不可签名" : "已通过模拟 · 可安全签名",
    },
    warn: {
      cls: "border-amber-400/40 bg-amber-400/10 text-amber-300",
      text: "已通过，但有提示项",
    },
    blocked: {
      cls: "border-rose-400/40 bg-rose-400/10 text-rose-300",
      text: "已拦截 · 切勿签名",
    },
  } as const;
  const v = map[verdict as keyof typeof map] ?? map.safe;
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs font-medium ${v.cls}`}>
      {v.text}
    </div>
  );
}

/* ── inner component: only renders when sim data is present ─── */

function SimulationContent({
  sim,
  address,
  isConnected,
  chainId,
  onSend,
  onReset,
  sendDisabled,
  sending,
  switching,
  sent,
  sendError,
  hasGas,
}: {
  sim: SimSuccess;
  address: string | undefined;
  isConnected: boolean;
  chainId: number | undefined;
  onSend: () => Promise<void>;
  onReset: () => void;
  sendDisabled: boolean;
  sending: boolean;
  switching: boolean;
  sent: string[];
  sendError: string | null;
  hasGas: boolean;
}) {
  const blocked = sim.verdict === "blocked";
  const effects = sim.simulation?.effects ?? {
    assetsOut: [], assetsIn: [], approvals: [],
    nftApprovals: [], nftsOut: [], nftsIn: [], recipients: [],
  };
  const warnings = sim.simulation?.warnings ?? [];
  const expectedSet = new Set((sim.expectedRecipients ?? []).map((a) => a.toLowerCase()));
  const accountMismatch =
    address && sim.plan?.account && sim.plan.account.toLowerCase() !== address.toLowerCase();

  // ── balance before/after ───────────────────────────────────
  const tokenRefs = useMemo(() => {
    const set = new Set<string>();
    try {
      effects.assetsOut.forEach((a: { token: string }) => set.add(a.token));
      effects.assetsIn.forEach((a: { token: string }) => set.add(a.token));
    } catch {/* empty */}
    return Array.from(set);
  }, [effects]);

  const tokenKey = tokenRefs.join(",");
  const [balances, setBalances] = useState<{ native: string; items: Record<string, string> } | null>(null);

  useEffect(() => {
    if (!address || tokenRefs.length === 0) {
      setBalances(null);
      return;
    }
    const erc20 = tokenRefs.filter((t) => t !== "native");
    let cancelled = false;
    fetch("/api/chain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "balances", address, tokens: erc20 }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d?.ok) return;
        const items: Record<string, string> = {};
        try {
          (d.items ?? []).forEach((it: { token: string; balance: string }) => {
            items[it.token.toLowerCase()] = it.balance;
          });
        } catch {/* ignore */}
        setBalances({ native: d.native, items });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [address, tokenKey]);

  const balanceRows = useMemo(() => {
    return tokenRefs.map((ref) => {
      try {
        const sum = (list: { token: string; amount: string }[]) => {
          try {
            return list
              .filter((a) => a.token.toLowerCase() === ref.toLowerCase())
              .reduce((acc, a) => acc + BigInt(a.amount || "0"), 0n);
          } catch {
            return 0n;
          }
        };
        const out = sum(effects.assetsOut as { token: string; amount: string }[]);
        const incoming = sum(effects.assetsIn as { token: string; amount: string }[]);
        const delta = incoming - out;
        const dec = safeDecimals(ref);
        const current =
          ref === "native"
            ? balances?.native
            : balances?.items?.[ref.toLowerCase()];
        const projected = current != null ? BigInt(current) + delta : null;
        return { ref, delta, current, projected, dec, sym: tokenLabel(ref) };
      } catch {
        return { ref, delta: 0n, current: null, projected: null, dec: 18, sym: ref.slice(0, 8) };
      }
    });
  }, [tokenRefs, effects, balances]);

  /* ── render ──────────────────────────────────────────────── */
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div>
        <h2 className="text-sm font-medium text-mist-200">后果透镜</h2>
        <p className="text-[11px] text-mist-400">{sim.summary}</p>
      </div>

      <VerdictBanner verdict={sim.verdict} reverted={sim.simulation?.reverted ?? false} />

      {sim.tamperNote && (
        <div className="rounded-lg border border-rose-400/40 bg-rose-400/5 px-3 py-2 text-[11px] leading-relaxed text-rose-300">
          <span className="font-medium">演示攻击注入：</span>
          {sim.tamperNote}
        </div>
      )}

      {/* ── Section: assets & approvals ─────────────────────── */}
      <SectionBoundary label="资金与授权">
        <section className="space-y-2">
          <h3 className="text-[11px] text-mist-400">资金与授权（模拟结果）</h3>

          <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
            <div className="mb-1 text-[11px] text-rose-300/80">流出</div>
            {(effects.assetsOut?.length ?? 0) === 0 && (
              <div className="text-[11px] text-mist-400">无</div>
            )}
            {(effects.assetsOut ?? []).map((a: { token: string; amount: string }, i: number) => (
              <div key={`out-${i}`} className="tabular text-xs text-rose-300">
                − <TokenAmount ref={a.token} amount={a.amount} />
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
            <div className="mb-1 text-[11px] text-emerald-300/80">流入</div>
            {(effects.assetsIn?.length ?? 0) === 0 && (
              <div className="text-[11px] text-mist-400">无</div>
            )}
            {(effects.assetsIn ?? []).map((a: { token: string; amount: string }, i: number) => (
              <div key={`in-${i}`} className="tabular text-xs text-emerald-300">
                + <TokenAmount ref={a.token} amount={a.amount} />
              </div>
            ))}
          </div>

          {(effects.approvals?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-400/30 bg-ink-850 px-3 py-2">
              <div className="mb-1 text-[11px] text-amber-300/80">授权</div>
              {(effects.approvals ?? []).map((a: { token: string; amount: string; spender: string }, i: number) => {
                const dec = safeDecimals(a.token);
                return (
                  <div key={`app-${i}`} className="text-xs text-amber-300">
                    批准{" "}
                    <span className="tabular">{formatApproval(a.amount, dec)}</span>{" "}
                    <span className="text-mist-400">{tokenLabel(a.token)}</span> 给{" "}
                    <span className="font-mono text-[11px]">{shortAddr(a.spender, 4)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {(effects.recipients?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
              <div className="mb-1 text-[11px] text-mist-400">收款方</div>
              {(effects.recipients ?? []).map((r: string, i: number) => {
                const declared = expectedSet.has(r.toLowerCase());
                return (
                  <div key={`rec-${i}`} className="flex items-center justify-between gap-2">
                    <span
                      className={`font-mono text-[11px] ${declared ? "text-mist-200" : "text-rose-300"}`}
                    >
                      {shortAddr(r, 6)}
                    </span>
                    {!declared && (
                      <span className="shrink-0 rounded bg-rose-400/15 px-1.5 py-0.5 text-[10px] text-rose-300">
                        未声明
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </SectionBoundary>

      {/* ── Section: balance impact ─────────────────────────── */}
      <SectionBoundary label="余额影响">
        {tokenRefs.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] text-mist-400">余额影响（签名前后）</h3>
            <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-[10px] text-mist-400">
                <span>资产</span>
                <span className="text-right">当前</span>
                <span className="text-right">变动</span>
                <span className="text-right">签名后≈</span>
              </div>
              {balanceRows.map((row) => {
                const deltaStr = `${row.delta >= 0n ? "+" : "\u2212"}${formatAmount(row.delta < 0n ? -row.delta : row.delta, row.dec, 4)}`;
                const deltaCls = row.delta > 0n ? "text-emerald-300" : row.delta < 0n ? "text-rose-300" : "text-mist-400";
                return (
                  <div key={row.ref} className="mt-1 grid grid-cols-[1fr_auto_auto_auto] gap-x-2 items-baseline">
                    <span className="truncate text-xs text-mist-200">{row.sym}</span>
                    <span className="tabular text-right text-[11px] text-mist-300">
                      {row.current != null ? formatAmount(String(row.current), row.dec, 4) : "\u2026"}
                    </span>
                    <span className={`tabular text-right text-[11px] ${deltaCls}`}>{deltaStr}</span>
                    <span className="tabular text-right text-[11px] text-mist-300">
                      {row.projected != null ? formatAmount(String(row.projected), row.dec, 4) : "\u2014"}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] leading-relaxed text-mist-400">
              这是 Moss 模拟出的真实余额变化\u2014\u2014签约前先看清楚你的钱包会少什么、多什么。
            </p>
          </section>
        )}
      </SectionBoundary>

      {/* ── Section: warnings ───────────────────────────────── */}
      <SectionBoundary label="安全告警">
        {(warnings?.length ?? 0) > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] text-mist-400">安全告警（{warnings.length}）</h3>
            {(warnings ?? []).map((w: { code: string; message: string }, i: number) => {
              const copy = WARNING_COPY[w.code] ?? { title: w.code, hint: w.message };
              return (
                <div
                  key={`warn-${i}`}
                  className="rounded-lg border border-rose-400/30 bg-rose-400/5 px-3 py-2"
                >
                  <div className="text-xs font-medium text-rose-300">{copy.title}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-mist-300">{copy.hint}</div>
                  <div className="mt-1 font-mono text-[10px] text-mist-400">{w.message}</div>
                </div>
              );
            })}
          </section>
        )}
      </SectionBoundary>

      {/* ── Footer: protocol info + send button (always safe) ── */}
      <section className="mt-auto space-y-2 border-t border-ink-700 pt-3">
        <div className="flex items-center justify-between text-[10px] text-mist-400">
          <span>
            协议 {sim.plan?.protocol ?? "\u2014"} \u00b7 {sim.plan?.method ?? "\u2014"}
          </span>
          <span className="font-mono">{shortAddr(sim.plan?.planHash ?? "", 6) || "\u2014"}</span>
        </div>

        {accountMismatch && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-300">
            当前钱包与模拟所用账户不一致，请连接 {shortAddr(sim.plan?.account ?? "", 4)} 后再签名。
          </div>
        )}

        {!blocked && (
          <>
            {!hasGas && (
              <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                <span className="font-medium">主网 Gas 不足：</span>
                你的钱包当前 MON 余额不足以支付交易 Gas 费。后果透镜的模拟预览（上方）不需要真实余额，但实际签名广播需要。
                可选方案：切换到测试网（免费）或往钱包转入少量 MON。
              </div>
            )}
            <p className="text-[10px] leading-relaxed text-mist-400">
              {MONAD_IS_TESTNET
                ? "签名并发送将在 Monad 测试网广播真实交易，使用免费水龙头代币，无真实价值，可放心演示。"
                : "签名并发送将在 Monad 主网广播真实交易，会消耗真实 MON 作为 Gas。金额很小，但它是真钱。"}
            </p>
          </>
        )}

        <button
          onClick={onSend}
          disabled={sendDisabled}
          className={`w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
            blocked
              ? "cursor-not-allowed border border-rose-400/40 bg-rose-400/10 text-rose-300"
              : "bg-violet-brand text-white hover:bg-violet-deep disabled:cursor-not-allowed disabled:opacity-50"
          }`}
        >
          {blocked
            ? "已拦截 \u00b7 不可签名"
            : !isConnected
              ? "请先连接钱包"
              : sending || switching
                ? "签名中\u2026"
                : sent.length > 0
                  ? "已广播"
                  : "签名并发送"}
        </button>

        {sendError && (
          <div className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-300">
            {sendError}
          </div>
        )}

        {sent.length > 0 && (
          <>
            <div className="space-y-1">
              {sent.map((h) => (
                <a
                  key={h}
                  href={explorerTx(h)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-lg border border-emerald-400/30 bg-emerald-400/5 px-3 py-1.5 text-[11px] text-emerald-300 hover:border-emerald-400/60"
                >
                  <span className="font-mono">{shortAddr(h, 6)}</span>
                  <span>在 {MONAD_IS_TESTNET ? "MonadExplorer" : "MonadScan"} 查看 \u2197</span>
                </a>
              ))}
            </div>
            <button
              onClick={onReset}
              className="w-full rounded-lg border border-ink-700 bg-ink-850 px-4 py-1.5 text-[11px] text-mist-400 transition-colors hover:border-violet-deep hover:text-violet-soft"
            >
              重新演示
            </button>
          </>
        )}
      </section>
    </div>
  );
}

/* ── outer shell: never crashes ────────────────────────────── */

export function ConsequencePanel({ sim }: { sim: SimResponse | null }) {
  const { address, isConnected, chainId } = useAccount();
  const { data: nativeBalance } = useBalance({ address, query: { enabled: Boolean(address) } });
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [sent, setSent] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Empty / error states — these are simple static JSX, cannot crash.
  if (!sim) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-sm text-mist-300">后果透镜</div>
        <p className="text-xs leading-relaxed text-mist-400">
          在中间的对话里让 Agent 帮你做一笔链上操作，AI 会在签名之前先用 Moss 模拟器把这笔交易的真实后果摊开在这里\u2014\u2014转走什么、收到什么、授权了什么、有没有告警。
        </p>
        <p className="mt-2 text-[11px] text-mist-400">看清楚，再签字。</p>
      </div>
    );
  }

  if (!sim.ok) {
    return (
      <div className="p-4">
        <div className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs text-rose-300">
          {sim.error}
        </div>
      </div>
    );
  }

  if (!mounted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-sm text-mist-300">后果透镜</div>
        <p className="text-xs text-mist-400">加载中\u2026</p>
      </div>
    );
  }

  const blocked = sim.verdict === "blocked";
  // On mainnet, require at least ~0.001 MON for gas; testnet is free.
  const hasGas = MONAD_IS_TESTNET || (nativeBalance?.value ?? 0n) >= 1_000_000_000_000n;
  const sendDisabled = blocked || !isConnected || sending || switching || sent.length > 0 || !hasGas || Boolean(
    address && sim.plan?.account && sim.plan.account.toLowerCase() !== address.toLowerCase()
  );

  /** Translate raw viem / RPC errors into user-friendly Chinese messages. */
  function translateSendError(raw: unknown): string {
    const msg = raw instanceof Error ? raw.message : String(raw ?? "发送失败");
    const lower = msg.toLowerCase();
    if (lower.includes("insufficient funds") || lower.includes("exceeds balance"))
      return "余额不足：钱包里的 MON 不够支付这笔交易的 Gas 费。主网交易需要真实 MON，请先充值或切换到测试网演示。";
    if (lower.includes("internal error") || lower.includes("request arguments chain"))
      return "签名失败：可能是钱包余额不足（主网需真实 MON 付 Gas），或 MetaMask 拒绝了该交易。请检查余额后重试。";
    if (lower.includes("user rejected") || lower.includes("user denied") || lower.includes("4001"))
      return "你取消了签名操作。";
    if (lower.includes("nonce") || lower.includes("replacement"))
      return "交易 nonce 冲突：请稍等几秒后重试。";
    if (lower.includes("gas") && (lower.includes("underpriced") || lower.includes("too low")))
      return "Gas 价格过低，网络拒绝接收。请稍后重试。";
    // Fallback: show first line only, truncate long technical dumps.
    const firstLine = msg.split("\n")[0].trim();
    return firstLine.length > 120 ? firstLine.slice(0, 117) + "\u2026" : firstLine;
  }

  function resetSend() {
    setSent([]);
    setSendError(null);
  }

  async function handleSend() {
    if (!sim || !sim.ok || blocked || !sim.plan?.txs?.length) return;
    setSendError(null);
    setSending(true);
    const hashes: string[] = [];
    try {
      if (chainId !== MONAD_CHAIN_ID) {
        await switchChainAsync({ chainId: MONAD_CHAIN_ID });
      }
      for (const tx of sim.plan.txs) {
        const h = await sendTransactionAsync({
          to: tx.to as `0x${string}`,
          data: (tx.data || "0x") as `0x${string}`,
          value: tx.value ? BigInt(tx.value) : 0n,
        });
        hashes.push(h);
        setSent([...hashes]); // 每笔成功即展示，避免部分失败丢失已广播哈希
      }
    } catch (e) {
      if (hashes.length > 0) setSent([...hashes]); // 部分成功也保留已广播交易
      setSendError(translateSendError(e));
    } finally {
      setSending(false);
    }
  }

  // Delegate ALL simulation rendering to the inner component.
  // If it throws, the outer PanelErrorBoundary (in page.tsx) catches it.
  return (
    <SimulationContent
      sim={sim as SimSuccess}
      address={address}
      isConnected={isConnected}
      chainId={chainId}
      onSend={handleSend}
      onReset={resetSend}
      sendDisabled={sendDisabled}
      sending={sending}
      switching={switching}
      sent={sent}
      sendError={sendError}
      hasGas={hasGas}
    />
  );
}
