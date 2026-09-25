import type { AgentAction, AgentReply } from "./types";
import { TOOL_DESCRIPTIONS } from "./types";
import type { IntentSpec, TamperMode } from "../capabilities";
import { MONAD_NETWORK_LABEL, MONAD_CHAIN_ID, TOKENS, findToken } from "../chain";

/** Supported ERC-20 symbols on the *active* network (testnet and mainnet lists
 *  differ, and the testnet regenesis dropped several). Derived, never
 *  hardcoded, so the model can never offer a token the chain no longer has. */
const TOKEN_SYMBOLS = Object.keys(TOKENS).join("、");

const SYSTEM_PROMPT = `你是 MonadLens 的链上助手，运行在 ${MONAD_NETWORK_LABEL}（chainId ${MONAD_CHAIN_ID}）。

铁律：
1. 你永远不持有、不索取用户私钥，也永远不会自己签名或广播交易。你只能构造未签名的交易计划，交由 Moss 模拟器验证，最后由用户在钱包里亲手签名。
2. 涉及链上数据的具体数字（TPS、余额、Gas、交易内容），必须来自工具返回的真实结果。绝不允许凭空编造数字或地址。
3. 用户要求执行链上操作时，调用 build_plan，不要口头描述交易参数当作已完成。
4. tamper 参数只有在用户明确要求"演示攻击 / 不安全交易 / 拦截效果"时才可设为非 none，正常请求必须是 none。
5. 回复用简体中文，简洁直接，不用客套话，不用 emoji。一到三句话为宜。
6. 你不支持代币兑换（swap / DEX）。用户想把 MON 换成 WMON 之外的代币（USDC、USDT、WETH 等）时，绝不能用 wrap 冒充——wrap 只会把 MON 变成 WMON，动的是另一种资产。
   正确做法：说明你不会替用户兑换（链上没有可接入的 DEX），然后指出兑换正是钓鱼重灾区，并调用 build_plan 用 kind 为 permit_drain 演示"假 DEX 页面骗你签名验证，实际把代币支配权交给攻击者"（token 必须是 USDC 这类 ERC-20，绝不能是 MON；attacker 用 0x0000000000000000000000000000000000000001；tamper 用 none）。
7. 回复正文里不要粘贴工具参数、JSON、地址以外的技术串。工具调用的结果由系统展示，你只说人话。

支持的代币：MON（原生）、${TOKEN_SYMBOLS}。
支持的操作：转账 MON、转账 ERC-20、MON 包装为 WMON、WMON 解包、ERC-20 授权、permit 重放攻击演示（kind 为 permit_drain，必须带 attacker 地址）。
构造交易时严格按工具参数的必填项补齐：转账要 to、授权要 spender、permit 重放要 attacker。
用户要求「演示攻击 / 演示拦截效果 / 演示一次不安全的交易」但没有给出具体地址时，一律用示例地址 0x0000000000000000000000000000000000000001 补齐参数并照常调用 build_plan；不要因为缺地址就只回一句话而不调用工具。`;

type ToolCall = { name: string; args: Record<string, unknown> };

/** Known tamper modes. A hallucinated value must not be cast blindly: it would
 * silently behave like "none" while the LLM claims it injected an attack. */
const TAMPER_MODES: string[] = [
  "none",
  "inflate_amount",
  "unlimited_approval",
  "hidden_approval",
  "swap_recipient",
  "spoof_recipient",
];
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

function positiveAmount(value: string): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function normalizeAction(call: ToolCall): AgentAction {
  switch (call.name) {
    case "network_stats":
      return { type: "network_stats" };
    case "explain_tx": {
      const hash = String(call.args.hash ?? "");
      // A blank / malformed hash only fails later on-chain; drop the action.
      return HEX64.test(hash) ? { type: "explain_tx", hash } : { type: "none" };
    }
    case "address_summary": {
      const address = String(call.args.address ?? "");
      return HEX40.test(address) ? { type: "address_summary", address } : { type: "none" };
    }
    case "build_plan": {
      const kind = String(call.args.kind ?? "");
      const amount = String(call.args.amount ?? "");
      const to = String(call.args.to ?? "");
      const token = String(call.args.token ?? "");
      const spender = String(call.args.spender ?? "");
      const attacker = String(call.args.attacker ?? "");
      const rawTamper = String(call.args.tamper ?? "none") || "none";
      const tamper = (TAMPER_MODES.includes(rawTamper) ? rawTamper : "none") as TamperMode;

      // Every plan needs a usable amount, otherwise buildPlan rejects it with a
      // confusing message far from where the user typed the request.
      if (!positiveAmount(amount)) return { type: "none" };

      let intent: IntentSpec;
      switch (kind) {
        case "wrap":
          intent = { kind: "wrap", amount };
          break;
        case "unwrap":
          intent = { kind: "unwrap", amount };
          break;
        case "transfer_erc20":
          if (!HEX40.test(to)) return { type: "none" };
          intent = { kind: "transfer_erc20", token, to, amount };
          break;
        case "approve":
          if (!HEX40.test(spender)) return { type: "none" };
          intent = { kind: "approve", token, spender, amount };
          break;
        case "permit_drain":
          // permit_drain carries `attacker`, not `to`. Falling through to the
          // transfer_native default used to hand buildPlan an empty recipient.
          if (!HEX40.test(attacker)) return { type: "none" };
          // Native MON has no permit(); models asked to "demo a swap scam" will
          // happily pass token=MON, which buildPlan rejects outright. Coerce to
          // a real ERC-20 so the demo runs instead of erroring.
          intent = {
            kind: "permit_drain",
            token: findToken(token) && token.toUpperCase() !== "MON" ? token : "USDC",
            attacker,
            amount,
          };
          break;
        default:
          if (!HEX40.test(to)) return { type: "none" };
          intent = { kind: "transfer_native", to, amount };
      }
      return { type: "build_plan", intent, tamper };
    }
    default:
      return { type: "none" };
  }
}

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

/**
 * Calls an OpenAI-compatible chat completions endpoint with function calling.
 * Works against OpenAI, DeepSeek, Moonshot, Zhipu, or any gateway that speaks
 * the same shape — only LLM_BASE_URL changes.
 */
export async function routeByLLM(message: string, account?: string): Promise<AgentReply> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY 未配置");

  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: account ? `[当前钱包地址: ${account}]\n${message}` : message,
          },
        ],
        tools: TOOL_DESCRIPTIONS.map((t) => ({ type: "function", function: t })),
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`模型返回 ${response.status}: ${detail.slice(0, 200)}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0]?.message;
    const rawCall = choice?.tool_calls?.[0]?.function;

    // When a tool call fired, the model sometimes attaches the raw tool-arg
    // JSON, SSE `data:` fragments, or "思考中…" reasoning markers to the
    // message `content`. That prose is NEVER shown verbatim — rule 7 of the
    // system prompt, but enforced here because models don't reliably comply
    // (a prior glm-4 streaming glitch dumped `{"index":0…}` chunks into the
    // chat bubble). The structured result is rendered by the UI anyway.

    if (!rawCall) {
      const reply = sanitizeReply(choice?.content) || "我没太理解，换个说法试试？";
      return { reply, action: { type: "none" }, engine: "llm" };
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawCall.arguments || "{}");
    } catch {
      args = {};
    }

    const action = normalizeAction({ name: rawCall.name, args });
    const reply = sanitizeReply(choice?.content) || defaultReplyFor(action);
    return { reply, action, engine: "llm" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Hard sanitizer for the LLM's prose reply. Models (esp. glm-4) occasionally
 * leak transport/tooling artifacts into `content`: SSE `data:` lines, the
 * streamed tool-call shape `{"index":0,…}`, reasoning markers ("思考中…"), or
 * verbatim ```` ```json ```` blocks. None of that belongs in the user bubble,
 * so strip it all and collapse the leftover whitespace. If a tool call fired,
 * this lets any short human sentence survive while killing attached JSON.
 */
function sanitizeReply(raw: string | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return "";

  // SSE framing — both inline `data:{…}` chunks and bare `data:` lines.
  s = s.replace(/data:\s*\{[\s\S]*?\}/g, "");
  s = s.replace(/^data:/gm, "");
  // Reasoning / thinking markers (zh + en) and tool-call code fences.
  s = s.replace(/思考中…|thinking|reason|<tool_call:6124c78e>|```(?:json)?[\s\S]*?```/gi, "");
  // Streamed OpenAI tool-call objects and function-call blobs.
  s = s.replace(/\{"index"\s*:\s*\d[\s\S]*?\}/g, "");
  s = s.replace(/\{"name"\s*:\s*"[a-z_]+"[\s\S]*?\}/g, "");

  // Collapse the whitespace the stripping leaves behind.
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function defaultReplyFor(action: AgentAction): string {
  switch (action.type) {
    case "network_stats":
      // Follow the build-time network switch: a testnet demo must never claim
      // to be reading mainnet.
      return `这是 ${MONAD_NETWORK_LABEL}此刻的实时状态。`;
    case "explain_tx":
      return "我去链上把这笔交易拉出来看看。";
    case "address_summary":
      return "我查一下这个地址的链上情况。";
    case "build_plan":
      return "已构造好未签名交易，先交给模拟器验证后果。";
    default:
      return "好的。";
  }
}
