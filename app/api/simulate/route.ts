import { NextResponse } from "next/server";
import { createRuntime } from "@themoss/core";
import { createTraceSimulator, SimulatorUnavailableError } from "@themoss/simulator";
import {
  buildPlan,
  tamperAfterSealing,
  CapabilityError,
  type BuildRequest,
  type BuiltPlan,
} from "@/lib/capabilities";
import { MONAD_RPC_HTTP_LIST, MONAD_CHAIN_ID, MONAD_IS_TESTNET } from "@/lib/chain";

// Moss simulation is a Node-only concern: it needs debug_traceCall over HTTP
// and must never run on the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Try each configured RPC in order. Not every public node exposes
// debug_traceCall, so we fall through to the next endpoint until one works.
const simulators = MONAD_RPC_HTTP_LIST.map((rpcUrl) => ({
  rpcUrl,
  simulator: createTraceSimulator(createRuntime({ rpcUrl, chainId: MONAD_CHAIN_ID })),
}));

export type Verdict = "safe" | "warn" | "blocked";

/**
 * Moss reports observed recipients but deliberately treats them as
 * informational — its envelope only constrains *how much* leaves, not *where*
 * it goes. MonadLens closes that gap: we know which address the user was shown,
 * so any other address receiving value is a payout swap.
 */
const UNDECLARED_RECIPIENT = "UNDECLARED_RECIPIENT";

function recipientWarning(
  observed: readonly string[],
  expected: readonly string[],
): { code: string; message: string } | null {
  const allow = new Set(expected.map((a) => a.toLowerCase()));
  const strangers = observed.filter((a) => !allow.has(a.toLowerCase()));
  if (strangers.length === 0) return null;
  return {
    code: UNDECLARED_RECIPIENT,
    message:
      expected.length === 0
        ? `这笔操作声明不转出任何资金，实际却有 ${strangers.length} 个地址收到了钱：${strangers.join("、")}`
        : `资金流向了未声明的地址：${strangers.join("、")}（你被告知的收款方是 ${expected.join("、")}）`,
  };
}

/**
 * A second MonadLens-only check (Moss never inspects address *appearance*):
 * if any declared recipient contains non-ASCII / invisible characters — the
 * classic zero-width-character spoof where the shown address looks identical
 * to the real one — flag it. This is the address-layer counterpart to the
 * recipient reconciliation above; together they close two gaps Moss leaves.
 */
const MISLEADING_ADDRESS = "MISLEADING_ADDRESS";

function misleadingAddressWarning(
  expected: readonly string[],
): { code: string; message: string } | null {
  const suspicious = expected.filter((a) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (suspicious.length === 0) return null;
  return {
    code: MISLEADING_ADDRESS,
    message: `声明里的收款地址含有不可见 / 形似字符（零宽字符等），肉眼无法分辨，但它是另一个不同的地址：${suspicious.join("、")}`,
  };
}

/**
 * A third MonadLens-only check (Moss never inspects a signature's *provenance*):
 * a permit-replay attack grants an allowance via an off-chain EIP-2612
 * signature the victim was socially engineered into signing (it looks like
 * "verify / log in"). Moss traces the resulting permit + transferFrom calldata
 * but has no notion that the allowance originated from a tricked signature —
 * nor that the same signature is replayable across sessions / chains. This is
 * the signature-provenance counterpart to the recipient + address blind spots;
 * it fires unconditionally because the danger is the attack's origin, not
 * whether the trace happened to revert.
 */
/**
 * A fourth MonadLens-only check: the zero address is a black hole. Moss
 * reconciles *how much* leaves the wallet and matches declared recipients, but
 * has no notion of whether the payee can ever spend the funds — so a transfer
 * to 0x000…000 simulates perfectly clean and reads "safe" while permanently
 * destroying the balance. This is the classic copy-the-wrong-address mistake,
 * and it is irreversible.
 */
const BURN_ADDRESS = "BURN_ADDRESS";

function burnAddressWarning(
  addrs: readonly string[],
): { code: string; message: string } | null {
  const zero = addrs.filter((a) => /^0x0{40}$/i.test(String(a).trim()));
  if (zero.length === 0) return null;
  return {
    code: BURN_ADDRESS,
    message: `收款方是零地址 0x000…000：资金一旦转入即永久销毁，任何人都无法再取出（包括你自己），且不可撤销：${[...new Set(zero)].join("、")}`,
  };
}

const PERMIT_REPLAY_RISK = "PERMIT_REPLAY_RISK";

function permitReplayWarning(): { code: string; message: string } {
  return {
    code: PERMIT_REPLAY_RISK,
    message:
      "这笔授权来自一份离链 EIP-2612 permit 签名——你以为是在 DApp 里「签名验证 / 登录」，实际把代币支配权签给了攻击者，同一份签名还能跨会话、跨链重放。本 demo 用占位签名，trace 里 permit 会因签名无效而回滚；真实攻击中攻击者持有你的有效签名，会真正授予授权并抽干余额。Moss 只看 calldata、看不到签名来源，这条盲区由 MonadLens 补上。",
  };
}

function decideVerdict(reverted: boolean, warnings: { code: string }[]): Verdict {
  if (reverted) return "blocked";
  const blocking = new Set([
    "PLAN_TAMPERED",
    "OUTFLOW_EXCEEDS_MAX",
    "UNDECLARED_OUTFLOW",
    "APPROVAL_EXCEEDS_MAX",
    "UNDECLARED_APPROVAL",
    "NFT_OPERATOR_GRANTED",
    "UNDECLARED_NFT_OUT",
    UNDECLARED_RECIPIENT,
    // Irreversible: sending to 0x0 destroys the funds outright, so this must
    // hard-block the sign button rather than just warn.
    BURN_ADDRESS,
  ]);
  if (warnings.some((w) => blocking.has(w.code))) return "blocked";
  return warnings.length > 0 ? "warn" : "safe";
}

/**
 * Runs the Moss trace simulator against every configured RPC.
 *
 * Two failure modes this is built around (both observed on Monad testnet):
 *
 *  1. ONE SLOW ENDPOINT POISONED THE RESULT. The previous version raced
 *     `Promise.all(attempts)` against a 25 s timeout. Promise.all only settles
 *     when *every* endpoint settles, so an endpoint that hangs — or one that
 *     rejects `debug_traceCall` slowly, e.g. Monad Foundation's public node
 *     which disallows debug_* — held the whole request to the 25 s wire even
 *     though a good endpoint had already answered in 2 s. Measured: 14 s, 24 s
 *     and outright timeouts for the same request.
 *     Fix: per-endpoint timeouts + resolve on the FIRST success.
 *
 *  2. PUBLIC NODES ARE FLAKY, not broken. A single trace can time out and then
 *     succeed a second later, so one miss used to fail the whole demo.
 *     Fix: retry within the overall budget.
 *
 * A reverted plan is a *successful* trace (verdict=blocked), not an error —
 * only RPC / method-unavailable failures count as failures here.
 */
type Simulator = ReturnType<typeof createTraceSimulator>;
type SimOutcome = Awaited<ReturnType<Simulator["simulate"]>>;
type Attempt =
  | { ok: true; value: SimOutcome; rpcUrl: string }
  | { ok: false; error: unknown; rpcUrl: string };

const OVERALL_TIMEOUT_MS = 25_000;
const PER_ENDPOINT_TIMEOUT_MS = 9_000;
const MAX_ROUNDS = 2;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Resolves with the first successful attempt, or the first failure if every
 *  endpoint failed. Safe because every attempt carries its own timeout. */
function firstSuccess(attempts: Promise<Attempt>[]): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    let remaining = attempts.length;
    let firstFailure: Attempt | undefined;
    for (const attempt of attempts) {
      attempt.then((result) => {
        if (result.ok) {
          resolve(result);
          return;
        }
        firstFailure ??= result;
        if (--remaining === 0) resolve(firstFailure);
      });
    }
  });
}

async function runSimulate(plan: BuiltPlan["plan"]): Promise<SimOutcome> {
  if (simulators.length === 0) {
    throw new SimulatorUnavailableError("未配置任何 RPC 端点");
  }

  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let lastError: unknown = new Error("所有 RPC 端点模拟失败");
  let rounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    rounds = round;

    const budget = Math.min(PER_ENDPOINT_TIMEOUT_MS, Math.max(2_000, remaining));
    const attempts = simulators.map(({ rpcUrl, simulator }) =>
      withTimeout(simulator.simulate([plan]), budget, `${rpcUrl} 响应超时`).then(
        (value): Attempt => ({ ok: true, value, rpcUrl }),
        (error): Attempt => ({ ok: false, error, rpcUrl }),
      ),
    );

    const result = await Promise.race([
      firstSuccess(attempts),
      // Wall-clock guard: firstSuccess always settles (every attempt has a
      // timeout), but this keeps the promise from outliving the request.
      new Promise<Attempt>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, error: new Error("本轮模拟整体超时"), rpcUrl: "" }),
          Math.max(1_000, remaining),
        ),
      ),
    ]);

    if (result.ok) return result.value;
    lastError = result.error;
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  throw new Error(
    `模拟超时：${rounds} 轮尝试内所有 RPC 端点均无响应（公共节点偶发抖动，已自动重试 ${rounds} 次）。${detail ? `最后错误：${detail}` : ""}请再试一次。`,
  );
}

export async function POST(request: Request) {
  let body: BuildRequest & { tamperAfterSeal?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!body?.intent || !body?.account) {
    return NextResponse.json({ ok: false, error: "缺少 intent 或 account" }, { status: 400 });
  }

  let built: BuiltPlan;
  try {
    built = buildPlan(body);
  } catch (err) {
    if (err instanceof CapabilityError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Sealed-then-mutated plan: proves planHash actually protects anything.
  let planToSimulate = built.plan;
  let tamperNote = built.tamperNote;
  if (body.tamperAfterSeal) {
    planToSimulate = tamperAfterSealing(built.plan);
    tamperNote = "已注入攻击：计划封印后交易被改写，planHash 不再匹配";
  }

  try {
    const outcome = await runSimulate(planToSimulate);
    const result = outcome.results[0];
    if (!result) {
      return NextResponse.json({ ok: false, error: "模拟未返回结果" }, { status: 502 });
    }

    // Moss's warnings plus our own recipient reconciliation AND address-safety
    // checks — both are MonadLens-built layers Moss does not provide.
    const recipientExtra = result.reverted
      ? null
      : recipientWarning(result.effects.recipients, built.expectedRecipients);
    const addressExtra = result.reverted
      ? null
      : misleadingAddressWarning(built.expectedRecipients);
    // Widened from Moss's `Warning[]` (whose `code` is a closed union) so the
    // MonadLens-built warnings below can be pushed into the same list.
    const warnings: { code: string; message: string }[] = [...result.warnings];
    if (recipientExtra) warnings.push(recipientExtra);
    if (addressExtra) warnings.push(addressExtra);
    // MonadLens self-built blind spots tagged by buildPlan (e.g. permit-replay
    // provenance). These fire unconditionally — the danger is the attack's
    // *provenance*, not the trace outcome, so they are not gated on `reverted`.
    for (const flag of built.lensFlags ?? []) {
      if (flag === "PERMIT_REPLAY") warnings.push(permitReplayWarning());
    }
    // Zero-address burn. Also unconditional: even if the plan reverted for some
    // other reason, the user still needs to know the payee is a black hole.
    const burnExtra = burnAddressWarning([
      ...built.expectedRecipients,
      ...(result.effects?.recipients ?? []),
    ]);
    if (burnExtra) warnings.push(burnExtra);

    // Testnet-only: Moss can't parse the testnet WMON mint event, so it wrongly
    // reports MIN_INFLOW_NOT_MET (到账不足). This is a known false positive on
    // testnet — suppress it so the lens stays clean for the free demo flow.
    const filteredWarnings = MONAD_IS_TESTNET
      ? warnings.filter((w) => w.code !== "MIN_INFLOW_NOT_MET")
      : warnings;

    return NextResponse.json({
      ok: true,
      summary: built.summary,
      tamperNote,
      expectedRecipients: built.expectedRecipients,
      verdict: decideVerdict(result.reverted, filteredWarnings),
      plan: {
        protocol: planToSimulate.protocol,
        method: planToSimulate.method,
        verb: planToSimulate.verb,
        intent: planToSimulate.intent,
        account: planToSimulate.account,
        chainId: planToSimulate.chainId,
        planHash: planToSimulate.planHash,
        declaredRisk: planToSimulate.declaredRisk,
        expects: planToSimulate.expects,
        txs: planToSimulate.txs,
      },
      simulation: {
        reverted: result.reverted,
        revertReason: result.revertReason ?? null,
        planHashValid: result.planHashValid,
        effects: result.effects,
        warnings: filteredWarnings,
        gasPerTx: result.gasPerTx,
        observations: result.observations,
      },
      halted: outcome.halted ?? null,
    });
  } catch (err) {
    if (err instanceof SimulatorUnavailableError) {
      return NextResponse.json(
        { ok: false, error: "该 RPC 节点不支持 debug_traceCall，模拟不可用" },
        { status: 503 },
      );
    }
    const raw = err instanceof Error ? err.message : "模拟失败";
    // Keep Chinese errors as-is; wrap English/technical dumps with a clear
    // Chinese lead-in so judges never see a bare English stack trace.
    const error = /[一-龥]/.test(raw) ? raw : `链上模拟失败（${raw}）`;
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
