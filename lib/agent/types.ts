import type { IntentSpec, TamperMode } from "../capabilities";

export type AgentAction =
  | { type: "none" }
  | { type: "network_stats" }
  | { type: "explain_tx"; hash: string }
  | { type: "address_summary"; address: string }
  | { type: "build_plan"; intent: IntentSpec; tamper: TamperMode; tamperAfterSeal?: boolean };

export type AgentReply = {
  reply: string;
  action: AgentAction;
  /** Which brain produced this: useful to show the judges the fallback works. */
  engine: "rules" | "llm";
  /** Present when the LLM path failed and we degraded to rules. */
  degradedReason?: string;
};

export const TOOL_DESCRIPTIONS = [
  {
    name: "network_stats",
    description:
      "读取 Monad 主网当前实时状态：TPS、出块间隔、Gas 使用率、基础费、最新区块高度。当用户询问网络状况、快不快、拥堵与否时使用。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "explain_tx",
    description: "根据交易哈希拉取链上交易并用中文解释它做了什么。",
    parameters: {
      type: "object",
      properties: { hash: { type: "string", description: "0x 开头的 66 位交易哈希" } },
      required: ["hash"],
    },
  },
  {
    name: "address_summary",
    description: "查询某个地址的 MON 余额、交易笔数以及是否为合约。",
    parameters: {
      type: "object",
      properties: { address: { type: "string", description: "0x 开头的 42 位地址" } },
      required: ["address"],
    },
  },
  {
    name: "build_plan",
    description:
      "当用户想执行链上操作时调用：转账 MON、转账 ERC-20、包装 MON 为 WMON、解包 WMON、授权代币额度。此工具只构造未签名交易并交给 Moss 模拟，绝不会自动签名或广播。",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["transfer_native", "transfer_erc20", "wrap", "unwrap", "approve"],
        },
        amount: { type: "string", description: "人类可读数量，例如 1.5" },
        to: { type: "string", description: "收款地址，转账时必填" },
        token: { type: "string", description: "代币符号，如 USDC、WMON" },
        spender: { type: "string", description: "被授权地址，授权时必填" },
        tamper: {
          type: "string",
          enum: ["none", "inflate_amount", "unlimited_approval", "hidden_approval", "swap_recipient"],
          description:
            "仅当用户明确要求演示不安全交易 / 攻击拦截时才设置为非 none，正常请求一律 none。",
        },
      },
      required: ["kind"],
    },
  },
] as const;
