import { NextResponse } from "next/server";
import { routeByRules } from "@/lib/agent/rules";
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

  if (!llmConfigured()) {
    return NextResponse.json(routeByRules(message));
  }

  // The LLM is an upgrade, never a dependency: any failure degrades to rules
  // so a dead API key can't take the demo down.
  try {
    return NextResponse.json(await routeByLLM(message, body.account));
  } catch (err) {
    const reason = err instanceof Error ? err.message : "模型调用失败";
    const fallback = routeByRules(message);
    return NextResponse.json({ ...fallback, degradedReason: reason });
  }
}
