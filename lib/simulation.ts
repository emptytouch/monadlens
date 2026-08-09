import type { IntentSpec, TamperMode } from "./capabilities";

export type Verdict = "safe" | "warn" | "blocked";

/** Extracted success branch of SimResponse for type-safe inner rendering. */
export type SimSuccess = Exclude<SimResponse, { ok: false }>;

export type SimWarning = { code: string; message: string };

export type SimEffects = {
  assetsOut: { token: string; amount: string }[];
  assetsIn: { token: string; amount: string }[];
  approvals: { token: string; spender: string; amount: string }[];
  nftApprovals: { collection: string; operator: string }[];
  nftsOut: { collection: string; count: number }[];
  nftsIn: { collection: string; count: number }[];
  recipients: string[];
};

export type SimResponse =
  | { ok: false; error: string }
  | {
      ok: true;
      summary: string;
      tamperNote?: string;
      /** 用户被告知的收款方，用于和模拟出的实际收款方对账。 */
      expectedRecipients: string[];
      verdict: Verdict;
      plan: {
        protocol: string;
        method: string;
        verb: string;
        intent: string;
        account: string;
        chainId: number;
        planHash: string;
        declaredRisk: string[];
        expects: Record<string, unknown>;
        txs: { from: string; to: string; data: string; value: string }[];
      };
      simulation: {
        reverted: boolean;
        revertReason: string | null;
        planHashValid: boolean;
        effects: SimEffects;
        warnings: SimWarning[];
        gasPerTx: (string | null)[];
        observations: unknown[];
      };
      halted: { planIndex: number; txIndex: number; reason: string } | null;
    };

export async function requestSimulation(
  payload: {
    intent: IntentSpec;
    account: string;
    tamper?: TamperMode;
    tamperAfterSeal?: boolean;
  },
  timeoutMs = 30000,
): Promise<SimResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return (await res.json()) as SimResponse;
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    // Return a typed failure instead of throwing, so the UI can show a retry
    // hint rather than leaving the user staring at a spinner forever.
    return {
      ok: false,
      error: aborted ? "模拟请求超时，请重试" : "无法连接模拟服务，请检查网络后重试",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Plain-language explanation for every Moss warning code. */
export const WARNING_COPY: Record<string, { title: string; hint: string }> = {
  REVERTED: {
    title: "交易会失败",
    hint: "在当前链上状态下这笔交易执行会回滚，签名只会白付 Gas。",
  },
  PLAN_TAMPERED: {
    title: "计划被篡改",
    hint: "交易内容在封印之后被改动过，planHash 对不上。绝对不要签名。",
  },
  CONFIRMATION_MISSING: {
    title: "缺少预期事件",
    hint: "模拟结果里没有出现协议本应触发的事件，实际行为可能与描述不符。",
  },
  UNDECLARED_OUTFLOW: {
    title: "未声明的资金流出",
    hint: "这笔交易会转走没有被事先告知的资产。",
  },
  OUTFLOW_EXCEEDS_MAX: {
    title: "转出金额超过声明",
    hint: "实际转出的数量高于向你声明的上限。",
  },
  UNDECLARED_APPROVAL: {
    title: "未声明的授权",
    hint: "这笔交易会把代币支配权交给某个地址，而这一点没有被告知。",
  },
  APPROVAL_EXCEEDS_MAX: {
    title: "授权额度超过声明",
    hint: "实际请求的授权额度高于向你声明的上限，常见于无限授权钓鱼。",
  },
  MIN_INFLOW_NOT_MET: {
    title: "到账不足",
    hint: "预期收到的资产低于承诺的下限。",
  },
  UNDECLARED_NFT_OUT: {
    title: "未声明的 NFT 转出",
    hint: "这笔交易会转走你的 NFT，而这一点没有被告知。",
  },
  NFT_OPERATOR_GRANTED: {
    title: "NFT 操作权被授予",
    hint: "某个地址将获得你整个 NFT 系列的操作权限，风险极高。",
  },
  // MonadLens 自己加的一层：Moss 只约束「转出多少」，不约束「转给谁」。
  UNDECLARED_RECIPIENT: {
    title: "收款地址与声明不符",
    hint: "钱最终流向了你没有被告知的地址，典型的收款方掉包攻击。",
  },
};
