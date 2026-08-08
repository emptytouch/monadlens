# MonadLens

**看清网络，看清后果，然后才签字。**

一个跑在 Monad 主网上的对话式链上助手。你用中文说要做什么，它构造交易；但在你签名之前，它先把这笔交易**真实执行后会发生什么**摊开给你看——转走什么、收到什么、授权给谁、钱最终落到哪个地址。

> LXDAO × Monad 线上黑客松参赛作品

---

## 我们在解决什么问题

AI Agent 帮人发链上交易，正在变成默认交互方式。但这里有个没人正面回答的问题：

**Agent 告诉你的，和 calldata 真正要做的，是两件事。**

一个把 `transfer(you, 1)` 说成"转 1 个"的 Agent，和一个把 `transfer(attacker, 5)` 也说成"转 1 个"的 Agent，在聊天框里长得一模一样。你签的是后者，看到的是前者。

钱包能告诉你"这是一笔合约调用"，区块浏览器能在事后告诉你钱去哪了。**没人在签名之前，用人话告诉你后果。**

MonadLens 就是那一层。

## 它长什么样

三栏，一屏之内完成"看网络 → 说需求 → 看后果 → 签字"：

| 左栏 · 主网仪表盘 | 中栏 · 对话 Agent | 右栏 · 后果透镜 |
|---|---|---|
| WebSocket 订阅 Monad 主网新区块，实时 TPS 曲线、出块间隔、Gas 占用、基础费、最新区块流 | 中文自然语言下单：查网络、解释交易、查地址、构造转账/包装/授权 | 签名前的模拟结果：资金流出、流入、授权明细、收款方对账、安全告警、以及那颗**签名按钮** |

关键设计：**签名按钮由模拟结果控制**。判定为 `blocked` 时按钮直接不可点——不是提示，是拦住。

## 技术核心：Moss Onchain Agent SDK

后果透镜跑在 [Moss](https://www.npmjs.com/package/@themoss/core) 上。Moss 的思路很对我们胃口：

1. **Plan 是自描述的。** 构造交易时同时声明"我预期转出多少、收到多少、授权多少"（`expects`），然后 `finalizePlan()` 把整个计划连同 calldata 一起哈希封印成 `planHash`。
2. **模拟做的是对账，不是预测。** `createTraceSimulator()` 通过 Monad RPC 的 `debug_traceCall` 拿到真实执行轨迹，然后把**实际效果**和**声明内容**逐项比对。不一致就报警。

```
用户意图 ──► buildPlan() ──► Plan { txs, expects, planHash }
                                   │
                            simulate([plan])   ← debug_traceCall on Monad mainnet
                                   │
                    实际效果 ⟷ 声明内容 逐项对账
                                   │
                         warnings ──► verdict ──► 签名按钮开/关
```

Moss 提供 10 类告警（`REVERTED` / `PLAN_TAMPERED` / `OUTFLOW_EXCEEDS_MAX` / `UNDECLARED_APPROVAL` / `APPROVAL_EXCEEDS_MAX` / `MIN_INFLOW_NOT_MET` / ...）。

### MonadLens 在 Moss 之上补了一层：收款方对账

Moss 的信封约束的是**转出多少**，不约束**转给谁**——`effects.recipients` 在 Moss 里是纯信息字段，不参与告警。

这留下一个真实攻击面：**金额一分不差，收款地址被换掉**。声明的 `out.amountMax` 完全满足，Moss 不会报警。

MonadLens 知道用户在界面上被展示的收款方是谁（`expectedRecipients`），于是自己做这一层对账，产出 `UNDECLARED_RECIPIENT` 告警，并归入拦截级。收款方列表里，任何未声明的地址会被标红打上"未声明"。

这不是绕过 Moss，而是补上应用层才有的信息——只有应用知道"用户到底被告诉了什么"。

## 内置的 5 个攻击演示

产品自带一套"攻击注入"开关，用来证明这层防护不是摆设。**永远只在用户明确要求演示时启用**，正常请求一律 `tamper: none`。

| 演示 | 注入方式 | 被什么抓住 |
|---|---|---|
| 金额放大 | 声明转 1 份，calldata 转 5 份 | `OUTFLOW_EXCEEDS_MAX` |
| 无限授权 | 口头说批 100，calldata 请求 `uint256.max` | `APPROVAL_EXCEEDS_MAX` |
| 夹带授权 | 正常转账后面偷偷追加一笔无限授权 | `UNDECLARED_APPROVAL` |
| 收款方掉包 | 金额不动，收款地址换成攻击者 | `UNDECLARED_RECIPIENT` ← 本项目补的 |
| 封印后篡改 | 计划封印后改写 `tx.to` | `PLAN_TAMPERED`（planHash 对不上） |

5 条路径全部实测在 Monad 主网模拟下产出 `blocked`，签名按钮锁死。

## 演示脚本（约 3 分钟）

```
1. 打开页面 —— 左栏区块在实时滚动，这是真的主网，不是测试网
   "现在 Monad 网络怎么样？"
   → 出块间隔 ~0.3s，吞吐 ~40 tx/s，Gas 占用 4%

2. 正常操作，走通全流程
   "把 0.01 MON 包装成 WMON"
   → 右栏：流出 0.01 MON，流入 0.01 WMON，无告警，判定"可安全签名"
   → 连接钱包，点签名，MonadScan 上能查到

3. 现在让 Agent 变坏
   "演示一次不安全的授权，授权 100 USDC 给 0x2222..."
   → 右栏：授权额度 115792089237316195423570985008687907853269984665640564039457584007913129639935
   → 告警"授权额度超过声明"，判定"已拦截"，按钮锁死

4. 最隐蔽的一种
   "把收款地址换掉，转 0.5 MON 给 0x1111..."
   → 金额一分不差，但收款方那栏标红：0xdEaD...BEEF「未声明」
   → 这是 Moss 原生规则抓不到的，MonadLens 补的对账层抓住了

5. 最后证明封印有效
   "封印后篡改计划，把 1 MON 包装成 WMON"
   → planHash 校验失败，"计划被篡改，绝对不要签名"
```

## Agent 的双脑设计

`/api/agent` 有两条路径，规则引擎是**兜底而不是降级**：

- **规则引擎**（`lib/agent/rules.ts`）：纯正则确定性路由，零网络调用、零幻觉，覆盖全部演示路径。没有 API Key 也能完整跑通。
- **LLM**（`lib/agent/llm.ts`）：配置了 `LLM_API_KEY` 时启用，走 function calling，理解更自由的表达。**任何失败都自动回落到规则引擎**，并在气泡上标出"降级"。

一把过期的 Key 不该让 demo 当场翻车。响应里的 `engine` 字段会显示当前是哪个脑子在工作。

## 本地运行

需要 Node 22+。

```bash
npm install
npm run dev          # http://localhost:3000
```

生产构建：

```bash
npm run build && npm run start
```

### 环境变量（全部可选）

| 变量 | 说明 |
|---|---|
| `LLM_API_KEY` | 配了就走 LLM 路由，不配走规则引擎，功能不缺 |
| `LLM_BASE_URL` | OpenAI 兼容端点 |
| `LLM_MODEL` | 模型名 |

RPC 用 Monad 官方公共节点 `https://rpc.monad.xyz`，无需配置。

### 端到端自测

```bash
python scripts/e2e.py http://127.0.0.1:3000
```

覆盖 12 条 Agent 路由 + 3 条正常模拟 + 6 条攻击拦截 + 2 个链上查询，共 23 项。

## 技术栈

Next.js 16（App Router / Turbopack）· React 19 · TypeScript · Tailwind v4 · wagmi v3 + viem v2 · zustand · recharts · **@themoss/core + @themoss/simulator**

Monad 主网 chainId `143`，浏览器 [MonadScan](https://monadscan.com)。

## 工程上的几个决定

- **模拟只能跑在 Node runtime。** Moss 是 ESM-only 且依赖 `debug_traceCall`，`/api/simulate` 显式 `runtime = "nodejs"`，并在 `next.config.ts` 里用 `serverExternalPackages` 排除打包。
- **授权靠打标签声明，不靠手写。** `TxStep.approval` 由 `plan()` 折进 `expects`，声明和 calldata 天然绑定，杜绝"声明写对了但 calldata 写错了"这类自欺。
- **私钥永不进服务端。** 服务端只构造未签名交易和跑模拟，签名广播完全在浏览器里由 wagmi 完成。
- **主网而非测试网。** 测试网上的模拟没有真实状态，"这笔交易在当前链上状态下会失败"这句话才有意义。金额都设得很小，但它是真钱。

## 已知边界

- `unwrap` / ERC-20 转账需要账户真实持有对应代币，否则会正常 revert 并被 `REVERTED` 拦截——这是正确行为，不是 bug。
- 依赖 RPC 节点开放 `debug_traceCall`。节点不支持时接口返回 503 并明确告知，不会静默放行。
- 收款方对账目前覆盖原生币与 ERC-20 转账路径；NFT 与复杂多跳协议交互交由 Moss 原生规则处理。
