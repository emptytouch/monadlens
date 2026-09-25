"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useBalance, useSendTransaction, useSwitchChain } from "wagmi";
import type { SimResponse, SimSuccess } from "@/lib/simulation";
import {
  WARNING_COPY,
  WARNING_COPY_EN,
  LENS_WARNING_CODES,
  riskScore,
  RISK_LEVEL_LABELS,
  groupWarningsByDimension,
  type Lang,
  type RiskLevel,
  type SimWarning,
} from "@/lib/simulation";
import { MONAD_CHAIN_ID, MONAD_IS_TESTNET, explorerTx, tokenFromRef } from "@/lib/chain";
import { formatAmount, formatApproval, shortAddr } from "@/lib/format";
import { SectionBoundary } from "./SectionBoundary";
import { useChainStore } from "@/lib/store";

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

function RiskScore({ score, level, lang }: { score: number; level: RiskLevel; lang: Lang }) {
  const cls =
    level === "critical"
      ? "border-red-400/50 bg-red-400/10 text-red-300"
      : level === "high"
        ? "border-rose-400/40 bg-rose-400/5 text-rose-300"
        : level === "medium"
          ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
          : "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${cls}`}>
      <div className="text-2xl font-bold tabular leading-none">{score}</div>
      <div className="leading-tight">
        <div className="text-[10px] opacity-80">
          {lang === "en" ? "Risk score / 100" : "风险分 / 100"}
        </div>
        <div className="text-xs font-medium">{RISK_LEVEL_LABELS[level][lang]}</div>
      </div>
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
  gasState,
  netFeeGwei,
  netGasPct,
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
        gasState: "ok" | "low" | "unknown";
  /** Live network conditions, so the lens can price this signature. */
  netFeeGwei: number | null;
  netGasPct: number | null;
}) {
  const blocked = sim.verdict === "blocked";
  const effects = sim.simulation?.effects ?? {
    assetsOut: [], assetsIn: [], approvals: [],
    nftApprovals: [], nftsOut: [], nftsIn: [], recipients: [],
  };
  const warnings = sim.simulation?.warnings ?? [];
  // ── Direction 4: counterparty identity (client-side enrichment) ──
  // Collect every address that receives value or gets approval, then look each
  // one up via /api/chain so we can flag contract counterparties — a "WHO is
  // the other side" blind spot Moss never surfaces.
  const counterparties = useMemo(
    () =>
      Array.from(
        // Dedupe case-insensitively: the same address can arrive with different
        // checksumming (0xFb8b…C541 vs 0xfb8b…c541) and would render twice.
        new Set<string>(
          [
            ...(sim.expectedRecipients ?? []),
            ...(effects.recipients ?? []),
            ...(effects.approvals ?? []).map((a: { spender: string }) => a.spender),
          ]
            .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
            .map((a) => a.toLowerCase()),
        ),
      ),
    [sim.expectedRecipients, effects.recipients, effects.approvals],
  );
  const [identityMap, setIdentityMap] = useState<Record<string, { isContract: boolean; balance: string; nonce: number }>>({});
  const mapRef = useRef(identityMap);
  mapRef.current = identityMap;
  useEffect(() => {
    const missing = counterparties.filter((a) => mapRef.current[a] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((addr) =>
        fetch("/api/chain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "address_summary", address: addr }),
        })
          .then((r) => r.json())
          .then((d) => ({
            addr,
            // A failed lookup (e.g. getCode unsupported) must stay "unknown" —
            // defaulting to { isContract: false } would silently label a real
            // contract as an EOA and hide the counterparty warning.
            info: d?.ok
              ? { isContract: Boolean(d.isContract), balance: String(d.balance ?? "0"), nonce: Number(d.nonce ?? 0) }
              : null,
          }))
          .catch(() => ({ addr, info: null })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setIdentityMap((prev) => {
        const next = { ...prev };
        results.forEach((r) => {
          if (r.info) next[r.addr] = r.info;
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [counterparties.join(",")]);
  const identityWarnings = useMemo<SimWarning[]>(() => {
    const contractAddrs = counterparties.filter((a) => identityMap[a]?.isContract);
    if (contractAddrs.length === 0) return [];
    return [
      {
        code: "CONTRACT_COUNTERPARTY",
        message: `合约对手方（可运行任意代码）：${contractAddrs.map((a) => shortAddr(a, 4)).join("、")}`,
      },
    ];
  }, [counterparties, identityMap]);
  // Merge Moss warnings with the self-built identity warnings so the risk
  // score, engine split, gap map and structured reading all include it.
  const allWarnings = useMemo<SimWarning[]>(() => [...warnings, ...identityWarnings], [warnings, identityWarnings]);

  // Split by engine: Moss's native warning system vs MonadLens's own
  // recipient-reconciliation layer. This split IS the "not a Moss wrapper"
  // story — quantify it right in the UI.
  const lensWarnings = allWarnings.filter((w) => LENS_WARNING_CODES.has(w.code));
  const mossWarnings = allWarnings.filter((w) => !LENS_WARNING_CODES.has(w.code));
  const expectedSet = new Set((sim.expectedRecipients ?? []).map((a) => a.toLowerCase()));
  const accountMismatch =
    address && sim.plan?.account && sim.plan.account.toLowerCase() !== address.toLowerCase();

  // ── Direction 3: structured consequence reading ──
  const [lang, setLang] = useState<Lang>("zh");
  const risk = useMemo(() => riskScore(sim.verdict, allWarnings), [sim.verdict, allWarnings]);

  // ── Live network → consequences (dashboard feeds the lens) ──────────
  // "This tx moves 1 MON" only means something next to "and it costs this much
  // right now, on a network this busy". Priced from the live base fee and the
  // gas Moss measured for this exact plan.
  const totalGas = useMemo(
    () =>
      (sim.simulation?.gasPerTx ?? []).reduce<bigint>(
        (acc, g) => (g ? acc + BigInt(g) : acc),
        0n,
      ),
    [sim.simulation?.gasPerTx],
  );
  const estFeeMon =
    netFeeGwei != null && totalGas > 0n ? (Number(totalGas) * netFeeGwei) / 1e9 : null;
  const congested = netGasPct != null && netGasPct >= 60;
  const groups = useMemo(() => groupWarningsByDimension(allWarnings), [allWarnings]);
  const copyOf = (code: string): { title: string; hint: string } =>
    (lang === "en" ? WARNING_COPY_EN : WARNING_COPY)[code] ?? { title: code, hint: "" };
  const ui = lang === "en"
    ? {
        tamperPrefix: "Demo attack injected: ",
        netTitle: "Live network",
        baseFee: "Base fee",
        estGas: "Est. gas for this tx",
        congested: (pct: number) =>
          `Network is busy (${pct}% of block gas used) — read the consequences twice before signing.`,
        mossCovered: "Moss native: outflow amount · approval cap · NFT operator · event consistency",
        mossNoCheck: "Moss doesn't verify",
        gapFilled: "MonadLens fills ✓",
        gapIntro: "Moss natively cannot produce the alerts below — blind spots MonadLens fills",
        warnings: "Security warnings",
        reading: "Consequence reading",
      }
    : {
        tamperPrefix: "演示攻击注入：",
        netTitle: "当前网络",
        baseFee: "基础费",
        estGas: "这笔预估 Gas",
        congested: (pct: number) =>
          `网络当前较拥堵（区块 Gas 占用 ${pct}%），签名前更该看清后果。`,
        mossCovered: "Moss 原生告警：转出金额 · 授权额度 · NFT 操作权 · 事件一致性",
        mossNoCheck: "Moss 不校验",
        gapFilled: "MonadLens 补上 ✓",
        gapIntro: "以下告警 Moss 原生给不了——是 MonadLens 补上的盲区",
        warnings: "安全告警",
        reading: "后果解读",
      };

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
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-mist-200">
            {lang === "en" ? "Consequence Lens" : "后果透镜"}
          </h2>
          <p className="text-[11px] text-mist-400">{sim.summary}</p>
        </div>
        <button
          onClick={() => setLang(lang === "en" ? "zh" : "en")}
          className="shrink-0 rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1 text-[10px] text-mist-300 transition-colors hover:border-violet-deep hover:text-violet-soft"
        >
          {lang === "en" ? "中文" : "EN"}
        </button>
      </div>

      <VerdictBanner verdict={sim.verdict} reverted={sim.simulation?.reverted ?? false} />

      <RiskScore score={risk.score} level={risk.level} lang={lang} />

      {counterparties.length > 0 && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
          <div className="mb-1 text-[11px] text-mist-400">
            {lang === "en" ? "Counterparty identity" : "对手方身份"}
          </div>
          <div className="space-y-1">
            {counterparties.map((a) => {
              const info = identityMap[a];
              const isContract = info?.isContract;
              return (
                <div key={a} className="flex items-center gap-2 text-[11px]">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      isContract ? "bg-violet-brand/20 text-violet-soft" : "bg-ink-700 text-mist-300"
                    }`}
                  >
                    {isContract
                      ? lang === "en"
                        ? "Contract"
                        : "合约"
                      : lang === "en"
                        ? "EOA"
                        : "外部账户"}
                  </span>
                  <span className="font-mono text-mist-300">{shortAddr(a, 6)}</span>
                  {info === undefined && <span className="text-mist-500">…</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sim.tamperNote && (
        <div className="rounded-lg border border-rose-400/40 bg-rose-400/5 px-3 py-2 text-[11px] leading-relaxed text-rose-300">
          <span className="font-medium">{ui.tamperPrefix}</span>
          {sim.tamperNote}
        </div>
      )}

      {/* ── Section: assets & approvals ─────────────────────── */}
      <SectionBoundary label="资金与授权">
        <section className="space-y-2">
          <h3 className="text-[11px] text-mist-400">资金与授权（模拟结果）</h3>

          <div className="rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-3 py-2">
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

          <div className="rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-3 py-2">
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
            <div className="rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-3 py-2">
              <div className="mb-1 flex items-center justify-between text-[11px] text-mist-400">
                <span>收款方</span>
                <span className="text-[10px] text-violet-soft/80">MonadLens 对账（Moss 不校验收款方）</span>
              </div>
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
                        未声明 · 自研层检出
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
            <div className="rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-3 py-2">
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
              这是 Moss 模拟出的真实余额变化——签约前先看清楚你的钱包会少什么、多什么。
            </p>
          </section>
        )}
      </SectionBoundary>

      {/* ── Section: warnings ───────────────────────────────── */}
      <SectionBoundary label={ui.warnings}>
        {(allWarnings?.length ?? 0) > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] text-mist-400">
              {ui.warnings}（{allWarnings.length}）
              <span className="ml-1.5 font-normal">
                {lang === "en"
                  ? `Moss ×${mossWarnings.length} · MonadLens layer ×${lensWarnings.length}`
                  : `Moss 模拟 ×${mossWarnings.length} · MonadLens 对账层 ×${lensWarnings.length}`}
              </span>
            </h3>

            {/* Engine gap map — the core "not a Moss wrapper" proof: Moss
                constrains HOW MUCH leaves the wallet, MonadLens reconciles
                WHO receives it. Rendered only when the self-built layer
                actually caught something this round. */}
            {lensWarnings.length > 0 && (
              <div className="rounded-lg border border-violet-deep/40 bg-violet-brand/5 px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-violet-brand/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-soft">
                    自研层
                  </span>
                  <span className="text-[11px] font-medium text-violet-soft">{ui.gapIntro}</span>
                </div>
                <div className="mt-1.5 space-y-0.5 text-[10px] leading-relaxed text-mist-300">
                  <div className="flex items-center justify-between gap-2">
                    <span>{ui.mossCovered}</span>
                    <span className="shrink-0 text-emerald-300">已覆盖</span>
                  </div>
                  {lensWarnings.map((w: { code: string }, i: number) => (
                    <div className="flex items-center justify-between gap-2" key={`gap-${i}`}>
                      <span>{copyOf(w.code).title}</span>
                      <span className="shrink-0">
                        <span className="mr-1 text-mist-400 line-through">{ui.mossNoCheck}</span>
                        <span className="text-violet-soft">{ui.gapFilled}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {mossWarnings.map((w: { code: string; message: string }, i: number) => {
              const copy = copyOf(w.code);
              return (
                <div
                  key={`moss-warn-${i}`}
                  className="rounded-lg border border-rose-400/30 bg-rose-400/5 px-3 py-2"
                >
                  <div className="text-xs font-medium text-rose-300">{copy.title}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-mist-300">{copy.hint}</div>
                  <div className="mt-1 font-mono text-[10px] text-mist-400">{w.message}</div>
                </div>
              );
            })}
            {lensWarnings.map((w: { code: string; message: string }, i: number) => {
              const copy = copyOf(w.code);
              return (
                <div
                  key={`lens-warn-${i}`}
                  className="rounded-lg border border-violet-deep/50 bg-violet-brand/10 px-3 py-2"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-violet-brand/25 px-1.5 py-0.5 text-[10px] font-medium text-violet-soft">
                      自研层
                    </span>
                    <span className="text-xs font-medium text-rose-300">{copy.title}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-mist-300">{copy.hint}</div>
                  <div className="mt-1 font-mono text-[10px] text-mist-400">{w.message}</div>
                </div>
              );
            })}
          </section>
        )}
      </SectionBoundary>

      {/* ── Section: structured consequence reading (Direction 3) ── */}
      {groups.length > 0 && (
        <SectionBoundary label={ui.reading}>
          <section className="space-y-2">
            <h3 className="text-[11px] text-mist-400">{ui.reading}</h3>
            {groups.map((g) => (
              <div key={g.key} className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
                <div className="text-[11px] font-medium text-violet-soft">{g.label[lang]}</div>
                <ul className="mt-1 space-y-1">
                  {g.items.map((w: { code: string; message: string }, i: number) => {
                    const copy = copyOf(w.code);
                    return (
                      <li key={`${g.key}-${i}`} className="text-[11px] leading-relaxed text-mist-300">
                        <span className="text-rose-300">{copy.title}</span>
                        <span className="ml-1">{copy.hint}</span>
                        <span className="mt-0.5 block font-mono text-[10px] text-mist-400">{w.message}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        </SectionBoundary>
      )}

      {/* ── Footer: protocol info + send button (always safe) ── */}
      <section className="mt-auto space-y-2 border-t border-ink-700 pt-3">
        <div className="flex items-center justify-between text-[10px] text-mist-400">
          <span>
            协议 {sim.plan?.protocol ?? "—"} · {sim.plan?.method ?? "—"}
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
            <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
              <div className="mb-1 text-[10px] text-mist-400">
                {ui.netTitle}
                <span className="ml-1 text-mist-500">· 来自左侧实时看板</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-mist-400">{ui.baseFee}</span>
                <span className="tabular text-mist-200">
                  {netFeeGwei != null ? `${netFeeGwei.toFixed(2)} gwei` : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-mist-400">{ui.estGas}</span>
                <span className="tabular text-mist-200">
                  {estFeeMon != null ? `≈ ${estFeeMon.toFixed(5)} MON` : "—"}
                </span>
              </div>
              {congested && (
                <div className="mt-1 text-[10px] leading-relaxed text-amber-300">
                  {ui.congested(netGasPct!)}
                </div>
              )}
            </div>
            {gasState === "low" && (
              <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                <span className="font-medium">主网 Gas 不足：</span>
                你的钱包当前 MON 余额不足以支付交易 Gas 费。后果透镜的模拟预览（上方）不需要真实余额，但实际签名广播需要。
                可选方案：切换到测试网（免费）或往钱包转入少量 MON。
              </div>
            )}
            {gasState === "unknown" && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                余额查询失败（可能是 RPC 抖动）。这不影响上方的模拟预览；若要真实签名，请确认网络正常，或切换到测试网演示。
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
                  <span>在 {MONAD_IS_TESTNET ? "MonadExplorer" : "MonadScan"} 查看 ↗</span>
                </a>
              ))}
            </div>
            <button
              onClick={onReset}
              className="w-full rounded-xl border border-ink-700 bg-ink-900 shadow-panel px-4 py-1.5 text-[11px] text-mist-400 transition-colors hover:border-violet-deep hover:text-violet-soft"
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

export function ConsequencePanel({
  sim,
  onSent,
}: {
  sim: SimResponse | null;
  /** Report broadcast hashes upward so the live feed can highlight them. */
  onSent?: (hashes: string[]) => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  // Live network conditions come from the same store the dashboard renders,
  // so the lens prices a signature against the chain state the user just saw.
  const netFeeGwei = useChainStore((s) => s.series[s.series.length - 1]?.baseFeeGwei ?? null);
  const netGasPct = useChainStore((s) => s.series[s.series.length - 1]?.gasPct ?? null);
  const { data: nativeBalance, isLoading: balanceLoading } = useBalance({ address, query: { enabled: Boolean(address) } });
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [sent, setSent] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // A new simulation means a new demo: clear the previous broadcast result.
  // `sent` lives in this outer shell, so without this the sign button stayed
  // stuck on "已广播" (and disabled) after switching to another attack demo.
  const simKey = sim && sim.ok ? (sim.plan?.planHash ?? null) : null;
  useEffect(() => {
    setSent([]);
    setSendError(null);
  }, [simKey]);

  // Empty / error states — these are simple static JSX, cannot crash.
  if (!sim) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-sm text-mist-300">后果透镜</div>
        <p className="text-xs leading-relaxed text-mist-400">
          在中间的对话里让 Agent 帮你做一笔链上操作，AI 会在签名之前先用 Moss 模拟器把这笔交易的真实后果摊开在这里——转走什么、收到什么、授权了什么、有没有告警。
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
        <p className="text-xs text-mist-400">加载中…</p>
      </div>
    );
  }

  const blocked = sim.verdict === "blocked";
  // On mainnet, require at least ~0.000001 MON for gas; testnet is free.
  // Distinguish a *confirmed* low balance from a *failed/unfetched* one so a
  // transient RPC error can't disable the button with a misleading "no gas" msg.
  const MIN_GAS_WEI = 1_000_000_000_000n;
  const gasState: "ok" | "low" | "unknown" =
    MONAD_IS_TESTNET
      ? "ok"
      : nativeBalance !== undefined && (nativeBalance.value ?? 0n) < MIN_GAS_WEI
        ? "low"
        : nativeBalance === undefined && !balanceLoading
          ? "unknown"
          : "ok";
  const sendDisabled =
    blocked ||
    !isConnected ||
    sending ||
    switching ||
    sent.length > 0 ||
    gasState === "low" ||
    Boolean(address && sim.plan?.account && sim.plan.account.toLowerCase() !== address.toLowerCase());

  /** Translate raw viem / RPC errors into user-friendly Chinese messages. */
  function translateSendError(raw: unknown): string {
    const msg = raw instanceof Error ? raw.message : String(raw ?? "发送失败");
    const lower = msg.toLowerCase();
    if (lower.includes("insufficient funds") || lower.includes("exceeds balance"))
      return "余额不足：钱包里的 MON 不够支付这笔交易的 Gas 费。主网交易需要真实 MON，请先充值或切换到测试网演示。";
    if (lower.includes("user rejected") || lower.includes("user denied") || lower.includes("4001"))
      return "你取消了签名操作。";
    // Contract rejected the tx during estimateGas (revert / bad params).
    if (lower.includes("estimategas") || lower.includes("execution reverted") || lower.includes("revert"))
      return "交易被合约拒绝（estimateGas 失败）。这笔交易在模拟中已被标记风险，请检查参数或收款方后再试。";
    if (lower.includes("wallet") && (lower.includes("locked") || lower.includes("unlock")))
      return "钱包被锁定，请先在浏览器扩展里解锁钱包后重试。";
    if (lower.includes("chain") && (lower.includes("not added") || lower.includes("unrecognized") || lower.includes("unknown")))
      return "当前网络不在钱包中，请先点击「添加网络」把 Monad 加进钱包。";
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("network") || lower.includes("failed to fetch"))
      return "网络超时或 RPC 无响应，请稍后重试。";
    if (lower.includes("nonce") || lower.includes("replacement"))
      return "交易 nonce 冲突：请稍等几秒后重试。";
    if (lower.includes("gas") && (lower.includes("underpriced") || lower.includes("too low")))
      return "Gas 价格过低，网络拒绝接收。请稍后重试。";
    if (lower.includes("internal error") || lower.includes("request arguments chain"))
      return "签名失败：可能是钱包余额不足（主网需真实 MON 付 Gas），或 MetaMask 拒绝了该交易。请检查余额后重试。";
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
        try {
          await switchChainAsync({ chainId: MONAD_CHAIN_ID });
        } catch {
          setSendError("你取消了网络切换，或钱包未添加 Monad 网络。请先点击「切到 Monad」/「添加网络」再签名。");
          return;
        }
      }
      for (const tx of sim.plan.txs) {
        const h = await sendTransactionAsync({
          to: tx.to as `0x${string}`,
          data: (tx.data || "0x") as `0x${string}`,
          value: tx.value ? BigInt(tx.value) : 0n,
        });
        hashes.push(h);
        setSent([...hashes]); // 每笔成功即展示，避免部分失败丢失已广播哈希
        onSent?.([h]); // 让左侧实时交易流高亮这一笔
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
      gasState={gasState}
      netFeeGwei={netFeeGwei}
      netGasPct={netGasPct}
    />
  );
}
