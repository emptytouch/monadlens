# MonadLens · 透视链

**看清网络，看清后果，然后才签字。**

一个跑在 Monad 链上的对话式链上助手。你用中文说要做什么，它构造交易；但在你签名之前，它先把这笔交易**真实执行后会发生什么**摊开给你看——转走什么、收到什么、授权给谁、钱最终落到哪个地址。

> Monad Metropolis 黑客松参赛作品 · Track 04 Trust / Identity & AI Infra

---

## 项目概述

MonadLens 是一个跑在 **Monad 链**上的对话式链上助手 + 签名前后果透镜。你用中文描述想做的事，Agent 构造交易；但在你签名之前，系统通过 [Moss SDK](https://www.npmjs.com/package/@themoss/core) 在真实链上状态中模拟执行，把"转出什么、收到什么、授权给谁、钱最终落到哪个地址"用人话摊开，并对收款方掉包、金额膨胀、无限授权等攻击实时拦截。三栏一屏完成"看网络 → 说需求 → 看后果 → 签字"。

项目支持 Monad 主网（chainId 143）与测试网（chainId 10143），通过环境变量一键切换；演示与本地验证默认走测试网免费水龙头，零成本跑通完整闭环。

## 参赛信息 · Monad Metropolis（Track 04）

- **赛事**：Monad Metropolis Hackathon（线上，Rise In 平台，截止 2026-10-13）
- **赛道**：Track 04 — Trust / Identity & AI Infra
- **一句话定位**：在 Agent 把意图变成签名之前，用人话告诉你这笔交易真实会发生什么，并拦下"Agent 说的"和"calldata 做的"不一致的交易。
- **为什么契合 AI Infra 赛道**：Agent 自动发链上交易正在成为默认交互，但"Agent 描述的效果"与"链上真实效果"之间存在无人值守的信任盲区。MonadLens 把这道盲区做成了**可验证、可拦截的基础设施层**——它不替代 Agent，而是给所有 Agent 生成的交易加一道"后果透镜"。
- **核心论点（评委看点）**：Moss 提供模拟内核，但 Moss 原生有三类**它根本看不到**的盲区（收款方归属、地址外观、离链签名溯源）。这三类由 MonadLens 在应用层补上。换言之，MonadLens 不是 Moss 套壳，而是在 Moss 之上长出了一层"只有应用才知道"的信任校验。

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
- **对话式 Agent 双脑**：规则引擎（零依赖、零幻觉）+ LLM（OpenAI 兼容，当前接入智谱 glm-4-flash，可一键切 DeepSeek / Moonshot / OpenAI）自动降级，中文自然语言查网络、解释交易、构造操作。
- **签名前后果透镜**：基于 Moss `debug_traceCall` 真实模拟，展示资金流出 / 流入、授权明细、收款方对账与安全告警。
- **7 类攻击护栏（含 3 类 Moss 原生抓不到、MonadLens 自研补上的盲区）**：金额膨胀、无限授权、夹带授权、收款方掉包、零宽字符掉包、permit 重放、封印后篡改——判定 `blocked` 时签名按钮直接锁死。
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

### MonadLens 在 Moss 之上补了三层：这是"不是 Moss 套壳"的关键

Moss 已经很强，但它的告警来自对 calldata 和信封（`expects`）的对账。有三件事是 Moss 原生**看不到**的——因为它们是"应用层才知道"的信息，而不是链上状态：

1. **收款方对账（`UNDECLARED_RECIPIENT`，拦截级）**：Moss 的信封约束的是**转出多少**，不约束**转给谁**——`effects.recipients` 在 Moss 里是纯信息字段，不参与告警。于是"金额一分不差、收款地址被换掉"的攻击能过 Moss。MonadLens 知道界面展示给用户的收款方（`expectedRecipients`），自己做对账，任何未声明地址标红"未声明"，并归入 `blocked`。
2. **地址外观检测（`MISLEADING_ADDRESS`，高风险）**：零宽字符 / 形似字符掉包，肉眼无法分辨、checksum 也认不出——这是展示层骗局，calldata 层面一切都"合法"。MonadLens 单独检测非 ASCII / 形近字符并告警。
3. **签名溯源（`PERMIT_REPLAY_RISK`，高风险）**：EIP-2612 permit 攻击里，危险在于那份**离链签名**——Moss 只看到 permit + transferFrom 的 calldata，看不到"这份授权来自你被社工诱导签下的离链 permit、且可跨会话/跨链重放"。MonadLens 在意图层就标出这条 provenance 盲区。

这三层不是绕过 Moss，而是补上只有应用层才有的信息——**只有应用知道用户到底被告诉了什么、看到了什么、签下了什么**。这也是参加 Trust / AI Infra 赛道的核心论点。

## 内置的 7 个攻击演示

产品自带一套"攻击注入"开关，用来证明这层防护不是摆设。**永远只在用户明确要求演示时启用**，正常请求一律 `tamper: none`。

| 演示 | 注入方式 | 被什么抓住 | 谁抓的 |
|---|---|---|---|
| 金额放大 | 声明转 1 份，calldata 转 5 份 | `OUTFLOW_EXCEEDS_MAX` | Moss |
| 无限授权 | 口头说批 100，calldata 请求 `uint256.max` | `APPROVAL_EXCEEDS_MAX` | Moss |
| 夹带授权 | 正常转账后偷偷追加一笔无限授权 | `UNDECLARED_APPROVAL` | Moss |
| 收款方掉包 | 金额不动，收款地址换成攻击者 | `UNDECLARED_RECIPIENT` | **MonadLens 自研** |
| 零宽字符掉包 | 展示的地址夹带不可见字符，肉眼与原地址一致 | `MISLEADING_ADDRESS` | **MonadLens 自研** |
| permit 重放 | 假 DEX"签名验证"实为 EIP-2612 permit 授权+抽干 | `PERMIT_REPLAY_RISK` | **MonadLens 自研** |
| 封印后篡改 | 计划封印后改写 `tx.to` | `PLAN_TAMPERED`（planHash 对不上） | Moss |

另有一条**兑换拦截**路径：用户要求把 MON 换成 USDC 等非 WMON 代币时，MonadLens 不做真兑换（测试网上无可用 DEX），而是直接演示"假 DEX 骗签名"的 permit 重放骗局——把"想换币"这个最高发钓鱼场景当场拆穿。

7 条路径全部实测在 Monad 测试网（默认演示网络）模拟下产出 `blocked`（自研 warn 级的两类在真实持币账户下表现为高风险告警；演示用零余额账户会触发 transferFrom revert，同样 `blocked`），签名按钮锁死。

## 演示脚本（约 3 分钟）

```
1. 打开页面 —— 左栏真实链上区块在滚动（演示默认走测试网，免费无风险），中栏可直接用中文下指令。
   "现在 Monad 网络怎么样？"  → 实时 TPS / 出块间隔 / Gas 占用 / 基础费。

2. 正常操作跑通全流程
   "把 0.01 MON 包装成 WMON"  → 右栏流出 0.01 MON / 流入 0.01 WMON，无告警，判定「可安全签名」；
   连接钱包点签名后可在 MonadScan 查到。

3. 让 Agent 变坏（金额类，Moss 抓）
   "演示一次不安全的授权，授权 100 USDC 给 0x2222…"
   → 授权额度 uint256.max（11579…39935），告警「授权额度超过声明」，判定「已拦截」，签名按钮锁死。

4. 最隐蔽的掉包（Moss 抓不到，MonadLens 自研）
   "把收款地址换掉，转 0.5 MON 给 0x1111…"
   → 金额一分不差，但收款方那栏标红 0xdEaD…BEEF「未声明」——Moss 原生规则漏掉，自研对账层抓住。
   （同类还有「零宽字符掉包」：展示的地址夹带不可见字符，肉眼与原地址一模一样。）

5. 离链签名的骗局（permit 重放，MonadLens 自研）
   "演示 permit 重放攻击"  → 右栏拆穿：你以为在 DApp 里「签名验证/登录」，实际签下 EIP-2612 permit，
   攻击者拿着这份可重放的离链签名 permit + transferFrom 抽干余额；Moss 只看到 calldata，看不出这是被社工
   诱导的离链签名——这条 provenance 盲区由 MonadLens 单独标出。

6. 兑换场景当场拆穿
   "把 1 MON 换成 USDC"  → MonadLens 不做真兑换（测试网无可用 DEX），而是直接演示「假 DEX 骗签名」的
   permit 重放骗局，把"想换币"这个最高发钓鱼场景拆给你看。

7. 最后证明封印有效
   "封印后篡改计划，把 1 MON 包装成 WMON"  → planHash 校验失败，「计划被篡改，绝对不要签名」。
```

## Agent 的双脑设计

`/api/agent` 有两条路径，规则引擎是**兜底而不是降级**：

- **规则引擎**（`lib/agent/rules.ts`）：纯正则确定性路由，零网络调用、零幻觉，覆盖全部演示路径。没有 API Key 也能完整跑通。
- **LLM**（`lib/agent/llm.ts`）：配置了 `LLM_API_KEY` 时启用，走 function calling，理解更自由的表达。**任何失败都自动回落到规则引擎**，并在气泡上标出"降级"。

一把过期的 Key 不该让 demo 当场翻车。响应里的 `engine` 字段会显示当前是哪个脑子在工作。

**确定性短路**：兑换请求（`把 MON 换成 USDC` 等）与明确的攻击演示短语（`掉包` / `封印后篡改` / `零宽` / `不安全授权` 等）会被**直接交给规则引擎**，跳过 LLM。这类路径是脚本化的，而 glm-4-flash 在把中文篡改提示映射到 `tamper` 字段上并不可靠——用确定性结果保证评委现场手打演示短语也一定能触发正确演示。只有自由表达（查网络、普通转账、闲聊）才走 LLM。

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

覆盖 15 条 Agent 路由 + 3 条正常模拟 + 8 条攻击/盲区拦截 + 2 个链上查询，共 28 项。

## 部署

MonadLens 是标准 Next.js 应用，模拟接口依赖 `debug_traceCall`，**必须运行在 Node.js runtime**（已在 `next.config.ts` 配置 `runtime = "nodejs"`）。

- **自托管 / VPS**：`npm run build` 后 `npm run start -- -p 3000`，用 Nginx / Caddy 反代并配置 HTTPS。
- **Netlify**：仓库已含 `netlify.toml`（Next.js 插件 + `npm run build`）。纯文档/资源类提交（pptx/docx/md/html）会被 `scripts/check-build.sh` 跳过构建，只有代码改动才触发部署。导入仓库即部署，Node 22+。
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
