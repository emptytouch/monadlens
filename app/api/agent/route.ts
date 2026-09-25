import { NextResponse } from "next/server";
import { routeByRules, isSwapRequest, isAttackDemo } from "@/lib/agent/rules";
import { routeByLLM, llmConfigured } from "@/lib/agent/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ llm: llmConfigured(), model: process.env.LLM_MODEL ?? null });
}

export async function POST(request: Request) {
  let body: { message?: string; account?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "消息为空" }, { status: 400 });
  }

  // Swap requests AND explicit attack-demo phrases go straight to the rules
  // engine, skipping the LLM entirely. Both are fully scripted paths, and the
  // model is unreliable at (a) not wrap-impersonating swaps and (b) mapping the
  // Chinese tamper cue onto the `tamper` flag. Determinism beats hoping for
  // compliance — a judge who *types* "把收款地址掉包" must get the right demo.
  if (isSwapRequest(message) || isAttackDemo(message)) {
    return NextResponse.json(routeByRules(message));
  }

  if (!llmConfigured()) {
    return NextResponse.json(routeByRules(message));
  }

  // The LLM is an upgrade, never a dependency: any failure degrades to rules
  // so a dead API key can't take the demo down.
  try {
    const reply = await routeByLLM(message, body.account);
    // Second safety net: the LLM is allowed to just chat, but models are
    // inconsistent (and sometimes outright decline) on "演示攻击 / 不安全交易"
    // requests that carry no explicit address — they answer with a bare
    // "好的。" and no tool call. If it yields nothing actionable while the rule
    // engine *would* build a plan, take the plan: a judge asking for an attack
    // demo must never get an empty reply during a live demo.
    if (reply.action.type === "none") {
      const planFallback = routeByRules(message);
      if (planFallback.action.type !== "none") {
        return NextResponse.json({
          ...planFallback,
          degradedReason: "LLM 未给出可执行动作，已由规则引擎兜底",
        });
      }
      // The rule engine may also have nothing to *do* but something to *say*:
      // e.g. "我不认识代币 USDT，目前支持 …". A bare LLM "好的。" would leave
      // the user with no answer at all, so a clarification wins over silence.
      if (/(不认识|目前支持|没把握理解|请先告诉)/.test(planFallback.reply)) {
        return NextResponse.json({
          ...planFallback,
          degradedReason: "LLM 未回答，已由规则引擎澄清",
        });
      }
    }
    return NextResponse.json(reply);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "模型调用失败";
    const fallback = routeByRules(message);
    return NextResponse.json({ ...fallback, degradedReason: reason });
  }
}
