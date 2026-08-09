"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { requestSimulation, type SimResponse } from "@/lib/simulation";
import type { AgentReply } from "@/lib/agent/types";
import { formatNumber, shortAddr } from "@/lib/format";
import { explorerTx, explorerAddress } from "@/lib/chain";

type ChatMessage = {
  id: number;
  role: "user" | "agent";
  text: string;
  engine?: "rules" | "llm";
  degraded?: string;
};

type Suggestion = string | { label: string; action: AgentReply["action"] };

const SUGGESTIONS: Suggestion[] = [
  "现在 Monad 网络多快",
  "把 1 MON 包装成 WMON",
  "转 0.1 MON 给 0x0000000000000000000000000000000000000000",
  {
    label: "🔓 收款方掉包",
    action: {
      type: "build_plan",
      intent: { kind: "transfer_native", to: "0x0000000000000000000000000000000000000001", amount: "0.1" },
      tamper: "swap_recipient",
    },
  },
  {
    label: "🔓 夹带授权",
    action: { type: "build_plan", intent: { kind: "wrap", amount: "1" }, tamper: "hidden_approval" },
  },
  {
    label: "🔓 金额膨胀",
    action: { type: "build_plan", intent: { kind: "wrap", amount: "1" }, tamper: "inflate_amount" },
  },
];

let seq = 0;
const nextId = () => ++seq;

function EngineBadge({ engine, degraded }: { engine?: string; degraded?: string }) {
  if (!engine) return null;
  return (
    <span
      className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] ${
        engine === "llm"
          ? "bg-violet-brand/20 text-violet-soft"
          : "bg-ink-700 text-mist-400"
      }`}
    >
      {engine === "llm" ? "LLM" : "规则引擎"}
      {degraded && <span className="ml-1 text-amber-300">· 降级</span>}
    </span>
  );
}

export function AgentChat({ onSimulate }: { onSimulate: (sim: SimResponse) => void }) {
  const { address } = useAccount();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: "agent",
      text:
        "我是 MonadLens 的链上助手。可以问我网络状况、解释一笔交易，或者让我帮你构造交易——任何链上操作我都会先用 Moss 模拟后果，绝不擅自签名。",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Prevent React #130 during hydration (wagmi's useAccount uses
  // useSyncExternalStore which differs between server and client).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const append = useCallback((msg: Omit<ChatMessage, "id">) => {
    setMessages((m) => [...m, { ...msg, id: nextId() }]);
  }, []);

  async function runAction(reply: AgentReply) {
    const a = reply.action;
    try {
      if (a.type === "network_stats") {
        const res = await fetch("/api/chain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "network_stats" }),
        }).then((r) => r.json());
        if (res?.ok) {
          append({
            role: "agent",
            text:
              `最新区块 #${res.blockNumber}，本区块 ${res.txCount} 笔交易。\n` +
              `出块间隔约 ${res.blockTimeSec ?? "—"}s，近期吞吐约 ${res.tps ?? "—"} tx/s。\n` +
              `基础费 ${formatNumber(res.baseFeeGwei ?? 0, 1)} gwei，Gas 占用 ${res.gasUsedPct}%。`,
            engine: reply.engine,
          });
        }
      } else if (a.type === "explain_tx") {
        const res = await fetch("/api/chain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "explain_tx", hash: a.hash }),
        }).then((r) => r.json());
        if (res?.ok) {
          const lines = [
            `交易 ${shortAddr(res.hash, 6)}（区块 #${res.blockNumber ?? "—"}，状态 ${res.status === "success" || res.status === 1 ? "成功" : res.status}）`,
            `从 ${shortAddr(res.from, 6)} 发往 ${res.to ? shortAddr(res.to, 6) : "合约创建"}，主币价值 ${res.value} MON`,
            res.tokenTransfers?.length
              ? `代币转账 ${res.tokenTransfers.length} 笔：${res.tokenTransfers
                  .map((t: { token: string; amount: string }) => `${t.amount} ${t.token}`)
                  .join("、")}`
              : "无 ERC-20 转账",
            res.approvalCount > 0 ? `⚠️ 包含 ${res.approvalCount} 笔授权操作` : "无授权操作",
            `MonadScan: ${explorerTx(res.hash)}`,
          ];
          append({ role: "agent", text: lines.join("\n"), engine: reply.engine });
        } else {
          append({ role: "agent", text: `查询失败：${res?.error ?? "未知错误"}`, engine: reply.engine });
        }
      } else if (a.type === "address_summary") {
        const res = await fetch("/api/chain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "address_summary", address: a.address }),
        }).then((r) => r.json());
        if (res?.ok) {
          append({
            role: "agent",
            text: `${res.isContract ? "合约" : "外部账户"} ${shortAddr(res.address, 6)}：余额 ${res.balance} MON，已发交易 ${res.nonce} 笔。${explorerAddress(res.address)}`,
            engine: reply.engine,
          });
        } else {
          append({ role: "agent", text: `查询失败：${res?.error ?? "未知错误"}`, engine: reply.engine });
        }
      } else if (a.type === "build_plan") {
        const sim = await requestSimulation({
          intent: a.intent,
          account: address ?? "0x0000000000000000000000000000000000000000",
          tamper: a.tamper,
          tamperAfterSeal: a.tamperAfterSeal,
        });
        onSimulate(sim);
        if (!sim.ok) {
          append({ role: "agent", text: `构造交易失败：${sim.error}`, engine: reply.engine });
        } else {
          const tail = sim.verdict === "blocked" ? "——已在右侧被 Moss 拦截。" : "——后果已摊在右侧，看清楚再决定要不要签名。";
          append({
            role: "agent",
            text: `已构造「${sim.summary}」的未签名交易并跑完模拟${tail}`,
            engine: reply.engine,
          });
        }
      }
    } catch (e) {
      append({
        role: "agent",
        text: `操作出错：${e instanceof Error ? e.message : "未知错误"}`,
        engine: reply.engine,
      });
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    append({ role: "user", text: message });
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, account: address }),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        append({ role: "agent", text: `服务异常：${errData.error ?? `HTTP ${res.status}`}` });
        return;
      }
      const reply: AgentReply = await res.json();
      append({ role: "agent", text: reply.reply, engine: reply.engine, degraded: reply.degradedReason });
      if (reply.action.type !== "none") {
        await runAction(reply);
      }
    } catch (e) {
      append({ role: "agent", text: `网络错误：${e instanceof Error ? e.message : "无法连接"}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleSuggestion(s: Suggestion) {
    if (typeof s === "string") {
      await send(s);
      return;
    }
    setBusy(true);
    try {
      // Attack demos run Moss interception on a placeholder address, so they
      // don't require a connected wallet — lower the demo barrier.
      if (!address) {
        append({ role: "agent", text: "未连接钱包，将使用演示账户地址进行 Moss 模拟（攻击拦截不依赖真实钱包）。" });
      }
      await runAction({
        reply: "正在构造演示交易并跑 Moss 模拟…",
        engine: "rules",
        action: s.action,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-medium text-mist-200">对话 Agent</h2>
          <p className="text-[11px] text-mist-400">自然语言 → 意图 → Moss 模拟 → 你签名</p>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[88%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                m.role === "user"
                  ? "bg-violet-brand/20 text-mist-100"
                  : "border border-ink-700 bg-ink-850 text-mist-200"
              }`}
            >
              <span className="whitespace-pre-line">{m.text}</span>
              {m.role === "agent" && (
                <span className="mt-1 block">
                  <EngineBadge engine={m.engine} degraded={m.degraded} />
                </span>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-[11px] text-mist-400">Agent 正在思考…</div>}
      </div>

      <div className="border-t border-ink-700 p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s, i) => {
            const label = typeof s === "string" ? s : s.label;
            const danger = typeof s !== "string";
            return (
              <button
                key={i}
                onClick={() => handleSuggestion(s)}
                disabled={busy}
                className={
                  danger
                    ? "rounded-full border border-rose-400/40 bg-rose-400/5 px-2.5 py-1 text-[10px] text-rose-300 transition-colors hover:border-rose-400 hover:text-rose-200 disabled:opacity-50"
                    : "rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1 text-[10px] text-mist-300 transition-colors hover:border-violet-deep hover:text-violet-soft disabled:opacity-50"
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="比如：把 2 MON 包装成 WMON"
            className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-mist-200 outline-none placeholder:text-mist-400 focus:border-violet-deep"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-lg bg-violet-brand px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-deep disabled:opacity-50"
          >
            发送
          </button>
        </form>
      </div>
    </div>
  );
}
