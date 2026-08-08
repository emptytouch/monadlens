import type { AgentAction, AgentReply } from "./types";
import { TOOL_DESCRIPTIONS } from "./types";
import type { IntentSpec, TamperMode } from "../capabilities";
import { MONAD_NETWORK_LABEL, MONAD_CHAIN_ID } from "../chain";

const SYSTEM_PROMPT = `你是 MonadLens 的链上助手，运行在 ${MONAD_NETWORK_LABEL}（chainId ${MONAD_CHAIN_ID}）。

铁律：
1. 你永远不持有、不索取用户私钥，也永远不会自己签名或广播交易。你只能构造未签名的交易计划，交由 Moss 模拟器验证，最后由用户在钱包里亲手签名。
2. 涉及链上数据的具体数字（TPS、余额、Gas、交易内容），必须来自工具返回的真实结果。绝不允许凭空编造数字或地址。
3. 用户要求执行链上操作时，调用 build_plan，不要口头描述交易参数当作已完成。
4. tamper 参数只有在用户明确要求"演示攻击 / 不安全交易 / 拦截效果"时才可设为非 none，正常请求必须是 none。
5. 回复用简体中文，简洁直接，不用客套话，不用 emoji。一到三句话为宜。

支持的代币：MON（原生）、WMON、USDC、WETH、AUSD、WSOL。
支持的操作：转账 MON、转账 ERC-20、MON 包装为 WMON、WMON 解包、ERC-20 授权。`;

type ToolCall = { name: string; args: Record<string, unknown> };

function normalizeAction(call: ToolCall): AgentAction {
  switch (call.name) {
    case "network_stats":
      return { type: "network_stats" };
    case "explain_tx":
      return { type: "explain_tx", hash: String(call.args.hash ?? "") };
    case "address_summary":
      return { type: "address_summary", address: String(call.args.address ?? "") };
    case "build_plan": {
      const kind = String(call.args.kind ?? "");
      const amount = String(call.args.amount ?? "");
      const to = String(call.args.to ?? "");
      const token = String(call.args.token ?? "");
      const spender = String(call.args.spender ?? "");
      const tamper = (String(call.args.tamper ?? "none") || "none") as TamperMode;

      let intent: IntentSpec;
      switch (kind) {
        case "wrap":
          intent = { kind: "wrap", amount };
          break;
        case "unwrap":
          intent = { kind: "unwrap", amount };
          break;
        case "transfer_erc20":
          intent = { kind: "transfer_erc20", token, to, amount };
          break;
        case "approve":
          intent = { kind: "approve", token, spender, amount };
          break;
        default:
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

    if (!rawCall) {
      return {
        reply: choice?.content?.trim() || "我没太理解，换个说法试试？",
        action: { type: "none" },
        engine: "llm",
      };
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawCall.arguments || "{}");
    } catch {
      args = {};
    }

    const action = normalizeAction({ name: rawCall.name, args });
    return {
      reply: choice?.content?.trim() || defaultReplyFor(action),
      action,
      engine: "llm",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function defaultReplyFor(action: AgentAction): string {
  switch (action.type) {
    case "network_stats":
      return "这是 Monad 主网此刻的实时状态。";
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
