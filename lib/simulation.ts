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
  // MonadLens 自己加的另一层：Moss 从不检查地址「外观」，所以零宽字符 /
  // 形似字符的地址伪装它管不到——这是地址维度的盲区补全。
  MISLEADING_ADDRESS: {
    title: "收款地址含有不可见字符",
    hint: "你看到的收款地址夹带了零宽字符等不可见字符，肉眼和真地址一模一样，但其实是另一个地址。Moss 不检查地址外观，这条由 MonadLens 自研检测标出。",
  },
  // MonadLens 自己加的第三层：Moss 只追踪 calldata 的行为（转出多少、授权多少、
  // 转给谁），但从不停留在一笔授权「是怎么来的」——离链 permit 签名是被社工
  // 诱导签下的、且可被重放，这条溯源盲区 Moss 给不了。
  PERMIT_REPLAY_RISK: {
    title: "授权来自被诱导签下的离链 permit",
    hint: "这笔授权来自一份 EIP-2612 离链 permit 签名——你以为是在 DApp 里「签名验证/登录」，实际把代币支配权签给了攻击者，同一份签名还能被重放。本 demo 用占位签名，trace 中 permit 会因签名无效而回滚；真实攻击里攻击者持有有效签名会真正执行。Moss 只看 calldata、看不到签名来源，这条由 MonadLens 自研标出。",
  },
  BURN_ADDRESS: {
    title: "收款方是零地址（黑洞）",
    hint: "资金一旦转入 0x000…000 就永久销毁，任何人都无法再取出，且不可撤销。Moss 只核对转出金额与收款方是否与声明一致，看不出这个地址根本没有私钥能花这笔钱，这条由 MonadLens 补上。",
  },
  CONTRACT_COUNTERPARTY: {
    title: "对手方是合约地址",
    hint: "这笔交易的对手方是智能合约而非外部账户，它可以执行任意代码——转账或授权给合约比给个人地址风险更高。Moss 只核对金额与授权，不区分对手方是人是合约，这条由 MonadLens 补上。",
  },
};

/**
 * Warning codes produced by MonadLens's own reconciliation layer rather than
 * by Moss natively. Moss's warning system constrains HOW MUCH leaves your
 * wallet (outflow amounts, approval ceilings, NFT operators, event
 * consistency) but never WHO receives it — recipient reconciliation is the
 * gap MonadLens fills. The ConsequencePanel uses this set to split warnings
 * by engine and surface what the self-built layer adds on top of Moss.
 */
export const LENS_WARNING_CODES: ReadonlySet<string> = new Set([
  "UNDECLARED_RECIPIENT",
  "MISLEADING_ADDRESS",
  "PERMIT_REPLAY_RISK",
  "CONTRACT_COUNTERPARTY",
  "BURN_ADDRESS",
]);

/* ── Direction 3: structured consequence reading ──────────────── */

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Per-warning risk weights (0–100 scale). Moss-native codes describe *what*
 * moves; MonadLens lens codes describe *who/where/source* blind spots and
 * weigh heavily because they are the part Moss cannot see at all. */
export const RISK_WEIGHTS: Record<string, number> = {
  // Irreversible loss outranks a merely misdirected payment.
  BURN_ADDRESS: 45,
  UNDECLARED_RECIPIENT: 40,
  MISLEADING_ADDRESS: 35,
  PERMIT_REPLAY_RISK: 35,
  APPROVAL_EXCEEDS_MAX: 30,
  NFT_OPERATOR_GRANTED: 30,
  PLAN_TAMPERED: 30,
  UNDECLARED_APPROVAL: 25,
  UNDECLARED_OUTFLOW: 25,
  UNDECLARED_NFT_OUT: 25,
  OUTFLOW_EXCEEDS_MAX: 20,
  CONTRACT_COUNTERPARTY: 20,
  CONFIRMATION_MISSING: 10,
  MIN_INFLOW_NOT_MET: 5,
};

export function riskScore(
  verdict: Verdict,
  warnings: SimWarning[],
): { score: number; level: RiskLevel } {
  let raw = 0;
  for (const w of warnings) raw += RISK_WEIGHTS[w.code] ?? 0;
  let score = Math.min(100, raw);
  // Verdict floors: a blocked plan is at least "high", a warn at least
  // "medium", and a safe plan is capped low even if it carries noise.
  if (verdict === "blocked") score = Math.max(score, 80);
  else if (verdict === "warn") score = Math.max(score, 40);
  else score = Math.min(score, 10);
  const level: RiskLevel =
    score >= 80 ? "critical" : score >= 40 ? "high" : score >= 15 ? "medium" : "low";
  return { score, level };
}

export const RISK_LEVEL_LABELS: Record<RiskLevel, { zh: string; en: string }> = {
  low: { zh: "低风险", en: "Low risk" },
  medium: { zh: "中风险", en: "Medium risk" },
  high: { zh: "高风险", en: "High risk" },
  critical: { zh: "极高风险", en: "Critical risk" },
};

/** Consequence dimensions for the structured reading. Each dimension groups
 * related warnings so the judge sees *categories* of harm, not a flat list. */
export const RISK_DIMENSIONS: { key: string; label: { zh: string; en: string }; codes: string[] }[] = [
  {
    key: "recipient",
    label: { zh: "收款方归属", en: "Who receives funds" },
    codes: ["UNDECLARED_RECIPIENT", "MISLEADING_ADDRESS", "BURN_ADDRESS"],
  },
  {
    key: "signature",
    label: { zh: "签名溯源", en: "Signature provenance" },
    codes: ["PERMIT_REPLAY_RISK"],
  },
  {
    key: "approval",
    label: { zh: "授权风险", en: "Approval risk" },
    codes: ["UNDECLARED_APPROVAL", "APPROVAL_EXCEEDS_MAX", "NFT_OPERATOR_GRANTED"],
  },
  {
    key: "outflow",
    label: { zh: "资金流出", en: "Fund outflow" },
    codes: ["UNDECLARED_OUTFLOW", "OUTFLOW_EXCEEDS_MAX", "UNDECLARED_NFT_OUT"],
  },
  {
    key: "integrity",
    label: { zh: "交易完整性", en: "Tx integrity" },
    codes: ["PLAN_TAMPERED", "CONFIRMATION_MISSING", "REVERTED"],
  },
  {
    key: "identity",
    label: { zh: "对手方身份", en: "Counterparty identity" },
    codes: ["CONTRACT_COUNTERPARTY"],
  },
];

export type Lang = "zh" | "en";

export function groupWarningsByDimension(
  warnings: SimWarning[],
): { key: string; label: { zh: string; en: string }; items: SimWarning[] }[] {
  return RISK_DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    items: warnings.filter((w) => d.codes.includes(w.code)),
  })).filter((g) => g.items.length > 0);
}

/** English copy of every warning, mirroring WARNING_COPY, so the judge-facing
 * EN toggle can render the full consequence reading without relying on zh. */
export const WARNING_COPY_EN: Record<string, { title: string; hint: string }> = {
  REVERTED: {
    title: "Transaction will revert",
    hint: "This tx would fail on the current chain state; signing only wastes gas.",
  },
  PLAN_TAMPERED: {
    title: "Plan was tampered",
    hint: "Tx content changed after sealing; planHash no longer matches. Do NOT sign.",
  },
  CONFIRMATION_MISSING: {
    title: "Expected event missing",
    hint: "The simulated result lacks an event the protocol should have emitted; actual behavior may differ.",
  },
  UNDECLARED_OUTFLOW: {
    title: "Undeclared fund outflow",
    hint: "This tx moves assets you were never told about.",
  },
  OUTFLOW_EXCEEDS_MAX: {
    title: "Outflow exceeds declared",
    hint: "The actual amount sent is higher than the cap you were shown.",
  },
  UNDECLARED_APPROVAL: {
    title: "Undeclared approval",
    hint: "This tx grants token control to an address without telling you.",
  },
  APPROVAL_EXCEEDS_MAX: {
    title: "Approval exceeds declared",
    hint: "The requested allowance is higher than the cap you were told — common in unlimited-approval phishing.",
  },
  MIN_INFLOW_NOT_MET: {
    title: "Inflow below minimum",
    hint: "Assets received are below the promised minimum.",
  },
  UNDECLARED_NFT_OUT: {
    title: "Undeclared NFT outflow",
    hint: "This tx transfers your NFT without telling you.",
  },
  NFT_OPERATOR_GRANTED: {
    title: "NFT operator granted",
    hint: "An address gains control over your entire NFT collection — extremely risky.",
  },
  UNDECLARED_RECIPIENT: {
    title: "Recipient mismatch",
    hint: "Funds go to an address you were not told about — a classic payout-swap attack.",
  },
  MISLEADING_ADDRESS: {
    title: "Address has invisible characters",
    hint: "The recipient address contains zero-width / look-alike characters; it looks identical but is a different address. Moss never checks address appearance — flagged by MonadLens.",
  },
  PERMIT_REPLAY_RISK: {
    title: "Allowance from a tricked off-chain permit",
    hint: "This allowance comes from an EIP-2612 off-chain permit signature you were socially engineered into signing (it looked like 'verify / log in'); the same signature is replayable. Moss only sees the calldata, not the signature origin — flagged by MonadLens.",
  },
  BURN_ADDRESS: {
    title: "Recipient is the zero address (black hole)",
    hint: "Funds sent to 0x000…000 are destroyed permanently — nobody, including you, can ever move them again, and it cannot be undone. Moss only checks the amount and whether the recipient matches the declaration; it cannot tell that no key exists to ever spend those funds. Flagged by MonadLens.",
  },
  CONTRACT_COUNTERPARTY: {
    title: "Counterparty is a contract",
    hint: "The counterparty is a smart contract, not an EOA — it can execute arbitrary code. Sending funds or granting approval to a contract is riskier than to a personal address. Moss only checks amounts and approvals, not whether the counterparty is a contract — flagged by MonadLens.",
  },
};
