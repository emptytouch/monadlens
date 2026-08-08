import type { AgentReply } from "./types";
import type { IntentSpec, TamperMode } from "../capabilities";
import { findToken } from "../chain";

const TX_HASH = /0x[0-9a-fA-F]{64}/;
const ADDRESS = /0x[0-9a-fA-F]{40}\b/;
const AMOUNT = /(\d+(?:[.,]\d+)?)/;

function pickAmount(text: string): string | null {
  const m = text.match(AMOUNT);
  return m ? m[1].replace(",", ".") : null;
}

function pickToken(text: string): string | null {
  const upper = text.toUpperCase();
  for (const symbol of ["WMON", "USDC", "WETH", "AUSD", "WSOL"]) {
    if (upper.includes(symbol)) return symbol;
  }
  if (/\bMON\b/.test(upper)) return "MON";
  return null;
}

function pickTamper(text: string): TamperMode | "after_seal" | null {
  const t = text.toLowerCase();
  if (/篡改|改写|封印|tamper/.test(t)) return "after_seal";
  if (/无限|unlimited|无上限/.test(t)) return "unlimited_approval";
  if (/夹带|偷偷|隐藏|hidden|附加/.test(t)) return "hidden_approval";
  // Word order in Chinese is loose here: "换掉收款地址" and "收款地址换掉" are
  // the same request, so match both directions rather than one phrasing.
  if (/换.*地址|地址.*换|收款.*换|改.*收款|替换收款|掉包|swap.*recipient/.test(t)) {
    return "swap_recipient";
  }
  if (/攻击|恶意|不安全|骗|钓鱼|超额|放大|演示拦截|attack/.test(t)) return "inflate_amount";
  return null;
}

/**
 * Deterministic intent routing. This is the fallback brain: no API key, no
 * network call, no hallucination. It handles every scripted demo path, so the
 * product still works if the LLM is unavailable.
 */
export function routeByRules(message: string): AgentReply {
  const text = message.trim();
  const lower = text.toLowerCase();

  const hash = text.match(TX_HASH)?.[0];
  if (hash) {
    return {
      reply: "我去链上把这笔交易拉出来看看。",
      action: { type: "explain_tx", hash },
      engine: "rules",
    };
  }

  if (/tps|出块|网络|拥堵|状态|多快|gas|区块高度|性能/.test(lower)) {
    return {
      reply: "这是 Monad 主网此刻的实时状态。",
      action: { type: "network_stats" },
      engine: "rules",
    };
  }

  const tamperHint = pickTamper(lower);
  const tamper: TamperMode = tamperHint && tamperHint !== "after_seal" ? tamperHint : "none";
  const tamperAfterSeal = tamperHint === "after_seal";

  const address = text.match(ADDRESS)?.[0];
  const amount = pickAmount(text);
  const tokenHint = pickToken(text);

  if (/包装|wrap|换成\s*wmon/.test(lower) && !/解包|unwrap/.test(lower)) {
    if (!amount) return ask("要包装多少 MON？比如「把 1.5 MON 包装成 WMON」。");
    return plan(
      { kind: "wrap", amount },
      tamper,
      tamperAfterSeal,
      `准备把 ${amount} MON 包装成 WMON，先模拟给你看。`,
    );
  }

  if (/解包|unwrap|换回\s*mon/.test(lower)) {
    if (!amount) return ask("要解包多少 WMON？比如「解包 2 WMON」。");
    return plan(
      { kind: "unwrap", amount },
      tamper,
      tamperAfterSeal,
      `准备把 ${amount} WMON 解包成 MON，先模拟给你看。`,
    );
  }

  if (/授权|approve|allowance/.test(lower)) {
    const token = tokenHint && tokenHint !== "MON" ? tokenHint : "USDC";
    if (!address) return ask("要授权给哪个地址？把 0x 开头的地址发我。");
    if (!amount) return ask(`要授权多少 ${token}？比如「授权 100 ${token} 给 0x…」。`);
    // A generic "unsafe/attack" cue on an approval maps to unlimited approval
    // (the classic phishing pattern), not to inflating a transfer amount.
    const approveTamper: TamperMode = tamper === "inflate_amount" ? "unlimited_approval" : tamper;
    return plan(
      { kind: "approve", token, spender: address, amount },
      approveTamper,
      tamperAfterSeal,
      `准备授权 ${amount} ${token}，先模拟看看实际会批准多少。`,
    );
  }

  if (/转账|转给|转\s|发送|打给|transfer|send/.test(lower)) {
    if (!address) return ask("要转给哪个地址？把 0x 开头的地址发我。");
    if (!amount) return ask("要转多少？比如「转 0.1 MON 给 0x…」。");
    const token = tokenHint ?? "MON";
    if (token === "MON") {
      return plan(
        { kind: "transfer_native", to: address, amount },
        tamper,
        tamperAfterSeal,
        `准备转出 ${amount} MON，先模拟确认资金流向。`,
      );
    }
    const meta = findToken(token);
    if (!meta) return ask(`我不认识代币 ${token}，目前支持 MON / WMON / USDC / WETH / AUSD / WSOL。`);
    return plan(
      { kind: "transfer_erc20", token, to: address, amount },
      tamper,
      tamperAfterSeal,
      `准备转出 ${amount} ${token}，先模拟确认资金流向。`,
    );
  }

  if (address) {
    return {
      reply: "我查一下这个地址的链上情况。",
      action: { type: "address_summary", address },
      engine: "rules",
    };
  }

  if (/你好|hi|hello|help|帮助|能做什么|怎么用/.test(lower)) {
    return ask(
      "我能做三件事：看网络实时状态、解释链上交易、以及帮你构造交易并在签名前模拟后果。\n试试「现在网络多快」「把 1 MON 包装成 WMON」，或者「演示一次不安全的交易」。",
    );
  }

  return ask(
    "这句我没把握理解。可以试试：\n· 现在 Monad 网络多快\n· 把 1 MON 包装成 WMON\n· 转 0.1 MON 给 0x…\n· 演示一次不安全的授权",
  );
}

function ask(reply: string): AgentReply {
  return { reply, action: { type: "none" }, engine: "rules" };
}

function plan(
  intent: IntentSpec,
  tamper: TamperMode,
  tamperAfterSeal: boolean,
  reply: string,
): AgentReply {
  return {
    reply,
    action: { type: "build_plan", intent, tamper, tamperAfterSeal },
    engine: "rules",
  };
}
