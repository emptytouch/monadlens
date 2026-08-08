# MonadLens

**看清网络，看清后果，然后才签字。**

一个跑在 Monad 链上的对话式链上助手。你用中文说要做什么，它构造交易；但在你签名之前，它先把这笔交易**真实执行后会发生什么**摊开给你看——转走什么、收到什么、授权给谁、钱最终落到哪个地址。

> LXDAO × Monad 线上黑客松参赛作品

---

## 项目概述

MonadLens 是一个跑在 **Monad 链**上的对话式链上助手 + 签名前后果透镜。你用中文描述想做的事，Agent 构造交易；但在你签名之前，系统通过 [Moss SDK](https://www.npmjs.com/package/@themoss/core) 在真实链上状态中模拟执行，把"转出什么、收到什么、授权给谁、钱最终落到哪个地址"用人话摊开，并对收款方掉包、金额膨胀、无限授权等攻击实时拦截。三栏一屏完成"看网络 → 说需求 → 看后果 → 签字"。

项目支持 Monad 主网（chainId 143）与测试网（chainId 10143），通过环境变量一键切换；演示与本地验证默认走测试网免费水龙头，零成本跑通完整闭环。

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

## 主要功能

- **实时链上仪表盘**：WebSocket 订阅 Monad 区块，实时 TPS、出块间隔、Gas 占用、基础费与活跃地址 / 合约榜。
- **对话式 Agent 双脑**：规则引擎（零依赖、零幻觉）+ DeepSeek LLM（OpenAI 兼容）自动降级，中文自然语言查网络、解释交易、构造操作。
- **签名前后果透镜**：基于 Moss `debug_traceCall` 真实模拟，展示资金流出 / 流入、授权明细、收款方对账与安全告警。
- **5 类攻击护栏**：金额膨胀、无限授权、夹带授权、收款方掉包、封印后篡改——判定 `blocked` 时签名按钮直接锁死。
- **钱包集成**：连接钱包、签名广播、MonadScan 一键验证，并支持一键把 Monad 网络添加到钱包。
- **多网络 + 多 RPC 容错**：主网 / 测试网一键切换，RPC 多端点 fallback，主网余额预检与友好错误提示。

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
1. 打开页面 —— 左栏区块在实时滚动，这是真实的链上状态（演示默认走测试网，免费且无风险）
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

## 安装与运行

需要 Node 22+。

```bash
npm install
npm run dev          # 开发模式，http://localhost:3000
```

生产构建与启动：

```bash
npm run build && npm run start          # 默认 http://localhost:3000
# 或指定端口：
npm run start -- -p 3000
```

### 环境变量（全部可选，详见 .env.example）

| 变量 | 说明 |
|---|---|
| `LLM_API_KEY` | 服务端变量。配了就走 LLM 路由，不配走规则引擎，功能不缺 |
| `LLM_BASE_URL` | OpenAI 兼容端点（如 DeepSeek / Moonshot / Zhipu） |
| `LLM_MODEL` | 模型名 |
| `NEXT_PUBLIC_MONAD_NETWORK` | `mainnet`（默认）或 `testnet`；切换网络，**改后须重新 `npm run build`** |
| `NEXT_PUBLIC_MONAD_RPC_URLS` | 主网 RPC(HTTP) 端点列表，逗号分隔，首个为主用 |
| `NEXT_PUBLIC_MONAD_RPC_WS_URLS` | 主网 RPC(WS) 端点列表 |
| `NEXT_PUBLIC_MONAD_TESTNET_RPC_URLS` | 测试网 RPC(HTTP) 端点列表 |
| `NEXT_PUBLIC_MONAD_TESTNET_RPC_WS_URLS` | 测试网 RPC(WS) 端点列表 |

未配置 RPC 时使用 Monad 官方公共节点（主网 `https://rpc.monad.xyz`、测试网 `https://testnet-rpc.monad.xyz`）。`LLM_*` 为服务端变量，不进入浏览器；`NEXT_PUBLIC_*` 会打进浏览器 bundle，须为可公开值。

### 端到端自测

```bash
python scripts/e2e.py http://127.0.0.1:3000
```

覆盖 12 条 Agent 路由 + 3 条正常模拟 + 6 条攻击拦截 + 2 个链上查询，共 23 项。

## 部署

MonadLens 是标准 Next.js 应用，模拟接口依赖 `debug_traceCall`，**必须运行在 Node.js runtime**（已在 `next.config.ts` 配置 `runtime = "nodejs"`）。

- **自托管 / VPS**：`npm run build` 后 `npm run start -- -p 3000`，用 Nginx / Caddy 反代并配置 HTTPS。
- **Vercel / Serverless**：直接导入仓库，`build` 命令 `npm run build`，无需额外配置（确保平台使用 Node 22+）。
- **Docker**：基于 `node:22-alpine`，先 `npm install` 再 `npm run build && npm run start`。

部署前请把所需环境变量（见上方表格）配置到对应平台的环境变量面板；`NEXT_PUBLIC_` 类变量改了必须重新构建。

## 演示账号

本项目**无需演示账号**：交互基于用户自行连接的浏览器钱包（MetaMask / OKX 等）。

- 主网演示需钱包内有少量真实 MON 作为 Gas。
- 测试网演示可在 [Monad 水龙头](https://faucet.monad.xyz) 免费领取测试 MON，零成本跑通"模拟 → 签名 → 上链 → 验证"完整闭环。
- 页面提供「一键添加 Monad 网络到钱包」按钮，无需手动配置 RPC。

## 技术栈

Next.js 16（App Router / Turbopack）· React 19 · TypeScript · Tailwind v4 · wagmi v3 + viem v2 · zustand · recharts · **@themoss/core + @themoss/simulator**

Monad 主网 chainId `143`，浏览器 [MonadScan](https://monadscan.com)。

## 工程上的几个决定

- **模拟只能跑在 Node runtime。** Moss 是 ESM-only 且依赖 `debug_traceCall`，`/api/simulate` 显式 `runtime = "nodejs"`，并在 `next.config.ts` 里用 `serverExternalPackages` 排除打包。
- **授权靠打标签声明，不靠手写。** `TxStep.approval` 由 `plan()` 折进 `expects`，声明和 calldata 天然绑定，杜绝"声明写对了但 calldata 写错了"这类自欺。
- **私钥永不进服务端。** 服务端只构造未签名交易和跑模拟，签名广播完全在浏览器里由 wagmi 完成。
- **默认主网、演示走测试网。** 两者通过 `NEXT_PUBLIC_MONAD_NETWORK` 一键切换：主网是真实资产、金额设得很小；测试网用免费水龙头即可零成本跑通"模拟 → 签名 → 上链 → 验证"完整闭环，且透镜对测试网已知的 WMON 事件解析误报已在服务端抑制。

## 已知边界

- `unwrap` / ERC-20 转账需要账户真实持有对应代币，否则会正常 revert 并被 `REVERTED` 拦截——这是正确行为，不是 bug。
- 依赖 RPC 节点开放 `debug_traceCall`。节点不支持时接口返回 503 并明确告知，不会静默放行。
- 收款方对账目前覆盖原生币与 ERC-20 转账路径；NFT 与复杂多跳协议交互交由 Moss 原生规则处理。
