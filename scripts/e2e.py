# -*- coding: utf-8 -*-
"""MonadLens 端到端验证：agent 路由 + simulate 全部演示路径 + chain API"""
import json
import sys
import urllib.request
import urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3300"
ACCOUNT = "0x1234567890123456789012345678901234567890"
PEER = "0x1111111111111111111111111111111111111111"
SPENDER = "0x2222222222222222222222222222222222222222"


def post(path, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return {"__status": e.code, **json.loads(raw)}
        except Exception:
            return {"__status": e.code, "raw": raw[:300]}
    except Exception as e:  # noqa: BLE001
        return {"__error": str(e)}


def section(title):
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72)


results = {}

# ------------------------------------------------------------- 1. agent 路由
section("1. Agent 路由")
AGENT_CASES = [
    ("现在 Monad 网络怎么样？", "network_stats", None),
    ("把 1 MON 包装成 WMON", "build_plan", "none"),
    ("转 0.5 MON 给 " + PEER, "build_plan", "none"),
    ("授权 100 USDC 给 " + SPENDER, "build_plan", "none"),
    ("解释一下 0x" + "ab" * 32, "explain_tx", None),
    ("看下 " + ACCOUNT, "address_summary", None),
    ("演示一次不安全的转账，转 0.5 MON 给 " + PEER, "build_plan", "inflate_amount"),
    ("演示一次不安全的授权，授权 100 USDC 给 " + SPENDER, "build_plan", "unlimited_approval"),
    ("偷偷夹带一笔授权，转 0.01 MON 给 " + PEER, "build_plan", "hidden_approval"),
    ("把收款地址换掉，转 0.5 MON 给 " + PEER, "build_plan", "swap_recipient"),
    ("换掉收款地址，转 0.5 MON 给 " + PEER, "build_plan", "swap_recipient"),
    ("把收款地址用零宽字符掉包，转 0.5 MON 给 " + PEER, "build_plan", "spoof_recipient"),
    ("演示 permit 重放攻击", "build_plan", "none"),
    ("把 1 MON 换成 USDC", "build_plan", "none"),
    ("封印后篡改计划，把 1 MON 包装成 WMON", "build_plan", "after_seal"),
]
ok_n = 0
for text, expect_type, expect_tamper in AGENT_CASES:
    r = post("/api/agent", {"message": text, "account": ACCOUNT})
    act = r.get("action") or {}
    got_type = act.get("type")
    got_tamper = act.get("tamper")
    if act.get("tamperAfterSeal"):
        got_tamper = "after_seal"
    ok = got_type == expect_type and (expect_tamper is None or got_tamper == expect_tamper)
    ok_n += ok
    print(f"[{'PASS' if ok else 'FAIL'}] {text[:42]:<44} -> {got_type}/{got_tamper} "
          f"(期望 {expect_type}/{expect_tamper}) engine={r.get('engine')}")
    if not ok:
        print("        raw:", json.dumps(r, ensure_ascii=False)[:400])
results["agent"] = (ok_n, len(AGENT_CASES))

# --------------------------------------------------------- 2. simulate 正常
section("2. Simulate 正常路径（期望 safe）")
NORMAL = [
    ("wrap", {"intent": {"kind": "wrap", "amount": "0.01"}}),
    ("transfer_native", {"intent": {"kind": "transfer_native", "to": PEER, "amount": "0.01"}}),
    ("approve", {"intent": {"kind": "approve", "token": "USDC", "spender": SPENDER, "amount": "10"}}),
    # unwrap / transfer_erc20 依赖账户真实持有 WMON / USDC，演示账户没有，
    # 会正常 revert 并被 REVERTED 拦截——这本身也是产品该有的行为。
]
ok_n = 0
for name, payload in NORMAL:
    payload["account"] = ACCOUNT
    r = post("/api/simulate", payload)
    v = r.get("verdict")
    sim = r.get("simulation") or {}
    warns = [w.get("code") for w in (sim.get("warnings") or [])]
    ok = v == "safe"
    ok_n += ok
    print(f"[{'PASS' if ok else 'WARN'}] {name:<16} verdict={v} reverted={sim.get('reverted')} "
          f"revert={sim.get('revertReason')} warnings={warns}")
    if not ok and r.get("error"):
        print("        error:", r.get("error"))
results["normal"] = (ok_n, len(NORMAL))

# --------------------------------------------------------- 3. simulate 攻击
section("3. Simulate 攻击/篡改路径（期望 blocked）")
ATTACKS = [
    ("inflate_amount(native)",
     {"intent": {"kind": "transfer_native", "to": PEER, "amount": "0.01"}, "tamper": "inflate_amount"}, "blocked"),
    ("unlimited_approval",
     {"intent": {"kind": "approve", "token": "USDC", "spender": SPENDER, "amount": "10"}, "tamper": "unlimited_approval"}, "blocked"),
    ("hidden_approval(native)",
     {"intent": {"kind": "transfer_native", "to": PEER, "amount": "0.01"}, "tamper": "hidden_approval"}, "blocked"),
    ("hidden_approval(wrap)",
     {"intent": {"kind": "wrap", "amount": "0.01"}, "tamper": "hidden_approval"}, "blocked"),
    ("swap_recipient(native)",
     {"intent": {"kind": "transfer_native", "to": PEER, "amount": "0.01"}, "tamper": "swap_recipient"}, "blocked"),
    ("tamper_after_seal",
     {"intent": {"kind": "wrap", "amount": "0.01"}, "tamperAfterSeal": True}, "blocked"),
    ("spoof_recipient(native)",
     {"intent": {"kind": "transfer_native", "to": PEER, "amount": "0.01"}, "tamper": "spoof_recipient"}, "warn"),
    ("permit_drain",
     {"intent": {"kind": "permit_drain", "token": "USDC", "attacker": SPENDER, "amount": "100"}}, "blocked"),
]
ok_n = 0
for name, payload, mode in ATTACKS:
    payload["account"] = ACCOUNT
    r = post("/api/simulate", payload)
    v = r.get("verdict")
    sim = r.get("simulation") or {}
    warns = [w.get("code") for w in (sim.get("warnings") or [])]
    eff = sim.get("effects") or {}
    if mode == "blocked":
        ok = v == "blocked"
    else:  # warn-level self-built demo: must surface the warning (verdict safe is a fail)
        ok = v in ("blocked", "warn") and "MISLEADING_ADDRESS" in warns
    ok_n += ok
    print(f"[{'PASS' if ok else 'FAIL'}] {name:<24} verdict={v} planHashValid={sim.get('planHashValid')} "
          f"reverted={sim.get('reverted')} warnings={warns}")
    print(f"       声明收款={r.get('expectedRecipients')} 实际收款={eff.get('recipients')} "
          f"授权={eff.get('approvals')}")
    if not ok:
        print("        raw:", json.dumps(r, ensure_ascii=False)[:500])
results["attack"] = (ok_n, len(ATTACKS))

# --------------------------------------------------------------- 4. chain API
section("4. Chain API")
ok_n = 0
CHAIN = [
    ("network_stats", {"action": "network_stats"}),
    ("address_summary", {"action": "address_summary", "address": ACCOUNT}),
]
for name, payload in CHAIN:
    r = post("/api/chain", payload)
    ok = r.get("ok") is True or (r.get("__status") is None and "error" not in r)
    ok_n += ok
    print(f"[{'PASS' if ok else 'FAIL'}] {name:<16} -> {json.dumps(r, ensure_ascii=False)[:260]}")
results["chain"] = (ok_n, len(CHAIN))

section("汇总")
total_ok = total = 0
for k, (a, b) in results.items():
    total_ok += a
    total += b
    print(f"{k:<10} {a}/{b}")
print(f"{'TOTAL':<10} {total_ok}/{total}")
