import type { AgentReply } from "./types";
import type { IntentSpec, TamperMode } from "../capabilities";
import { findToken, TOKENS, MONAD_NETWORK_LABEL } from "../chain";

/**
 * Supported ERC-20 symbols, derived from the active network's token list
 * instead of hardcoded. The testnet regenesis (Apr 2026) dropped several
 * tokens (USDT, WSOL) and redeployed the rest — a hardcoded list would keep
 * advertising tokens that no longer exist on this network.
 */
const TOKEN_SYMBOLS = Object.keys(TOKENS);

/**
 * Symbols users commonly ask for that may NOT exist on the active network
 * (USDT / WSOL were dropped in the testnet regenesis). Recognising them lets
 * the agent say "I don't support that token" instead of silently falling back
 * to a native MON transfer — which would move the wrong asset entirely.
 */
const KNOWN_ERC20_SYMBOLS = ["USDT", "USDC", "DAI", "WBTC", "WSOL", "AUSD", "WETH", "WMON"];

const TX_HASH = /0x[0-9a-fA-F]{64}/;
const ADDRESS = /0x[0-9a-fA-F]{40}\b/;
const AMOUNT = /(\d+(?:[.,]\d+)?)/;
/** Addresses / tx hashes are hex blobs full of digits that are NOT amounts. */
const HEX_BLOB = /0x[0-9a-fA-F]{40,64}/g;
/** Stand-in counterparty so a bare demo phrase can still build a real plan. */
const DEMO_ADDRESS = "0x0000000000000000000000000000000000000001";

/** Amount must be present and positive. buildPlan otherwise rejects it with a
 * confusing "必须大于 0" deep in the request, so catch it here and ask instead. */
function isPositiveAmount(value: string | null): value is string {
  if (!value) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function pickAmount(text: string): string | null {
  // Strip hex blobs first: in "转给 0x0000… 0.5 MON" the naive first match grabs
  // the "0" inside "0x…" and yields amount=0.
  const withoutHex = text.replace(HEX_BLOB, " ");
  const m = withoutHex.match(AMOUNT);
  return m ? m[1].replace(",", ".") : null;
}

function pickToken(text: string): string | null {
  const upper = text.toUpperCase();
  // Supported tokens win first, so a network that has USDC never reports it
  // as "unsupported"; anything left over is known-but-absent → ask, don't guess.
  for (const symbol of TOKEN_SYMBOLS) {
    if (upper.includes(symbol)) return symbol;
  }
  for (const symbol of KNOWN_ERC20_SYMBOLS) {
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
  // Zero-width / look-alike character spoof. Must be tested BEFORE the generic
  // payout-swap cue below: "零宽字符掉包" contains "掉包" too, and swapping is
  // the weaker (and wrong) reading of that request.
  if (/零宽|不可见|隐形|形似|伪装|homoglyph|zero.?width|spoof/.test(t)) {
    return "spoof_recipient";
  }
  // Word order in Chinese is loose here: "换掉收款地址" and "收款地址换掉" are
  // the same request, so match both directions rather than one phrasing.
  if (/换.*地址|地址.*换|收款.*换|改.*收款|替换收款|掉包|swap.*recipient/.test(t)) {
    return "swap_recipient";
  }
  if (/攻击|恶意|不安全|骗|钓鱼|超额|放大|演示拦截|attack/.test(t)) return "inflate_amount";
  return null;
}

/**
 * Detects a swap/exchange request aimed at a non-WMON token. Exported so the
 * agent route can SHORT-CIRCUIT these to the rules engine: the LLM has twice
 * disobeyed the "never wrap-impersonate a swap" rule (once by wrapping, once
 * by dumping raw SSE chunks into `content`), and a swap request is a scripted
 * path anyway — deterministic handling beats hoping the model complies.
 */
export function isSwapRequest(message: string): boolean {
  const text = message.trim();
  const lower = text.toLowerCase();
  const tokenHint = pickToken(text);
  const swapTarget =
    tokenHint && tokenHint !== "WMON" && tokenHint !== "MON" ? tokenHint : null;
  const exchangeVerb = /兑换|换|swap/.test(lower) || /包装成|wrap\s*(to|into)/.test(lower);
  return Boolean(swapTarget && exchangeVerb);
}

/**
 * Detects an explicit attack-demo phrase ("演示攻击 / 收款地址掉包 / 封印后篡改…").
 * Exported so the agent route can SHORT-CIRCUIT these to the rules engine:
 * glm-4-flash routinely fails to map the Chinese tamper cue onto the `tamper`
 * field / `tamperAfterSeal` flag, so a judge who *types* the demo phrase would
 * get a no-op plan. The rules engine's `pickTamper` is deterministic and already
 * converts e.g. "不安全授权" → unlimited_approval, so routing these here makes
 * the scripted demos bullet-proof.
 *
 * Cues are intentionally limited to *demo/attack* vocabulary (演示 / 攻击 /
 * 掉包 / 封印 / 零宽 / 无限授权 / 夹带 / spoof …) rather than bare words like
 * "隐藏" or "偷偷", which can appear in ordinary questions about risk.
 */
const ATTACK_DEMO_CUES =
  /演示|攻击|恶意|钓鱼|骗|不安全|掉包|篡改|封印|零宽|无限授权|夹带|隐藏\s*授权|偷偷\s*授权|spoof|swap\s*recipient|recipient\s*swap|换\s*掉?\s*收款|收款\s*换|地址\s*换|换\s*掉?\s*地址/i;

export function isAttackDemo(message: string): boolean {
  return ATTACK_DEMO_CUES.test(message);
}

/** Deterministic intent routing. This is the fallback brain: no API key, no
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
      // Network label follows the build-time switch — a testnet demo must never
      // claim to be reading mainnet.
      reply: `这是 ${MONAD_NETWORK_LABEL}此刻的实时状态。`,
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

  // Swap requests ("把 MON 换成 USDC") are NOT supported — and must never be
  // silently downgraded to a wrap, which moves a *different asset* than the
  // user asked for. Detection lives in the exported isSwapRequest() so the
  // agent route can short-circuit these before the LLM ever sees them.
  if (isSwapRequest(text)) {
    // Don't just refuse — a swap request is the perfect opening for the scam
    // that actually happens on swaps. We never claim to trade for the user; we
    // show what a "swap" page would have tricked them into signing.
    // Tokens this network doesn't have (USDT/WSOL/…) fall back to USCC so the
    // demo still runs instead of erroring on an unknown token.
    const swapTarget = tokenHint && tokenHint !== "WMON" && tokenHint !== "MON" ? tokenHint : "USDC";
    const demoToken = findToken(swapTarget) ? swapTarget : "USDC";
    const attacker = address ?? DEMO_ADDRESS;
    const amt = isPositiveAmount(amount) ? amount : "100";
    return plan(
      { kind: "permit_drain", token: demoToken, attacker, amount: amt },
      "none",
      false,
      `我不做真兑换——${MONAD_NETWORK_LABEL}上没有我能接入的 DEX，所以不会替你把 MON 换成 ${swapTarget}。但兑换恰恰是钓鱼重灾区：最常见的骗局是"在假 DEX 页面点一下签名验证/登录"，实际把代币支配权签给了攻击者。我用 ${amt} ${demoToken} 把这个骗局跑一遍给你看：`,
    );
  }

  if (/包装|wrap|换成\s*wmon/.test(lower) && !/解包|unwrap/.test(lower)) {
    if (!isPositiveAmount(amount)) return ask("要包装多少 MON？比如「把 1.5 MON 包装成 WMON」。（金额要大于 0）");
    return plan(
      { kind: "wrap", amount },
      tamper,
      tamperAfterSeal,
      `准备把 ${amount} MON 包装成 WMON，先模拟给你看。`,
    );
  }

  if (/解包|unwrap|换回\s*mon/.test(lower)) {
    if (!isPositiveAmount(amount)) return ask("要解包多少 WMON？比如「解包 2 WMON」。（金额要大于 0）");
    return plan(
      { kind: "unwrap", amount },
      tamper,
      tamperAfterSeal,
      `准备把 ${amount} WMON 解包成 MON，先模拟给你看。`,
    );
  }

  // EIP-2612 permit replay: the attack lives in an off-chain signature, so it
  // is its own intent rather than a tamper mode layered on a normal transfer.
  // Checked before the approve branch so "离链签名授权" doesn't get read as a
  // plain allowance request.
  if (/permit|离链签名|签名.*重放|重放/.test(lower)) {
    const token = tokenHint && tokenHint !== "MON" ? tokenHint : "USDC";
    const attacker = address ?? DEMO_ADDRESS;
    const amt = isPositiveAmount(amount) ? amount : "100";
    return plan(
      { kind: "permit_drain", token, attacker, amount: amt },
      "none",
      false,
      `构造 permit 重放演示：${amt} ${token} 被一份离链签名授权给 ${attacker.slice(0, 10)}…，先模拟给你看。`,
    );
  }

  if (/授权|approve|allowance/.test(lower)) {
    const token = tokenHint && tokenHint !== "MON" ? tokenHint : "USDC";
    if (!address) return ask("要授权给哪个地址？把 0x 开头的地址发我。");
    if (!isPositiveAmount(amount)) return ask(`要授权多少 ${token}？比如「授权 100 ${token} 给 0x…」。（额度要大于 0）`);
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
    if (!isPositiveAmount(amount)) return ask("要转多少？比如「转 0.1 MON 给 0x…」。（金额要大于 0）");
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
    if (!meta) return ask(`我不认识代币 ${token}，目前支持 MON / ${TOKEN_SYMBOLS.join(" / ")}。`);
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

  // Our own help text advertises "演示一次不安全的交易", but that phrase carries
  // no action verb, so it used to fall through to "这句我没把握理解" — the
  // engine refusing an example it itself suggested. Default it to the canonical
  // demo (a wrap carrying the injected attack) so the advertised path works.
  if (tamperHint) {
    const demoAmount = isPositiveAmount(amount) ? amount : "1";
    // Recipient tampering only exists on transfers: a wrap silently ignores it,
    // which would make the "demo an attack" path show no attack at all. Route
    // those two to a native transfer instead.
    const recipientAttack = tamper === "swap_recipient" || tamper === "spoof_recipient";
    const intent: IntentSpec = recipientAttack
      ? { kind: "transfer_native", to: DEMO_ADDRESS, amount: demoAmount }
      : { kind: "wrap", amount: demoAmount };
    return plan(
      intent,
      tamper,
      tamperAfterSeal,
      `演示一次被注入攻击的交易：${demoAmount} MON ${recipientAttack ? "转账" : "包装"}，先模拟看 Moss 与 MonadLens 能否拦下。`,
    );
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
