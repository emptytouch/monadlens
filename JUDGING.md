# MonadLens · 评委速览（JUDGING）

> Track 04 — Trust / Identity & AI Infra · Monad Metropolis Hackathon
> 代码已上线（Netlify），仓库 + 演示 + 本文件三件套配套使用。

---

## 一、30 秒电梯陈述

> 当 AI Agent 替你发链上交易，它告诉你的"效果"和 calldata 真正"做"的，往往是两件事。
> **MonadLens 在签名之前，用真模拟把后果摊开给人看，并拦下"说的"和"做的"不一致的交易。**
> 它不是 Moss 的套壳——Moss 做模拟内核，但 Moss 原生有三类它看不到的盲区（收款方归属、地址外观、离链签名溯源），MonadLens 在应用层补上了。这正是 Trust / AI Infra 赛道要的"可验证的链上信任层"。

一句话定位：**给所有 Agent 生成的交易加一道"后果透镜"，让信任可验证、可拦截。**

---

## 二、评委可能问 & 标准答

| 评委问题 | 答 |
|---|---|
| 你只是 Moss 的套壳吧？ | 不是。Moss 提供 `debug_traceCall` 模拟内核；MonadLens 在它之上补了三层 Moss 原生抓不到的盲区（见第三节），并做了对话 Agent、实时看板、兑换骗局拆穿。Moss 是地基，MonadLens 是上面的信任层。 |
| 凭什么说"Trust / AI Infra"？ | Agent 自动发交易是默认交互，但"Agent 描述的效果 vs 链上真实效果"存在无人值守的信任盲区。MonadLens 把这个盲区做成了基础设施：可验证、可拦截、可审计。 |
| 这些攻击真能发生吗？ | 能。金额膨胀/无限授权/夹带授权/篡改是真实 calldata 手法；收款方掉包、零宽掉包、permit 重放是真实钓鱼手法。7 类全部在 Monad 测试网模拟下实测 `blocked`。 |
| 为什么测试网演示？ | 测试网免费、无真实资产风险，零成本跑通"模拟→签名→上链→验证"全链路；透镜对测试网已知代币事件已做误报抑制。主网逻辑一致（chainId 143）。 |
| LLM 不可用时怎么办？ | 双脑设计：规则引擎兜底，任何 LLM 失败自动降级，永不掉线。兑换与攻击演示短语走确定性规则，不依赖模型。 |

---

## 三、核心创新：Moss 之上补的三层（自研盲区）

Moss 的告警来自对 calldata 与信封（`expects`）的对账。有三件事 Moss 原生**看不到**——因为它们是"应用层才知道"的信息：

| 层 | 告警码 | Moss 为什么看不到 | MonadLens 怎么做 |
|---|---|---|---|
| ① 收款方对账 | `UNDECLARED_RECIPIENT` | Moss 只约束"转出多少"，不约束"转给谁"；`effects.recipients` 是纯信息字段 | 用界面声明的收款方 `expectedRecipients` 做对账，未声明地址标红 |
| ② 地址外观检测 | `MISLEADING_ADDRESS` | 零宽/形似字符掉包，calldata 全合法、肉眼与 checksum 都认不出 | 单独检测非 ASCII 与形近字符 |
| ③ 签名溯源 | `PERMIT_REPLAY_RISK` | Moss 只见 permit+transferFrom calldata，看不见这是被社工诱导签下的离链 permit、且可重放 | 在意图层标出 provenance 盲区 |

这三类是 **Moss 原生看不到、只有应用层才知道**的信息——这是参加本赛道的核心论点。

---

## 四、7 类攻击演示一览（签名前拦截）

| # | 演示 | 注入方式 | 被什么抓住 | 谁抓的 |
|---|---|---|---|---|
| 1 | 金额膨胀 | 声明转 1 份，calldata 转 5 份 | `OUTFLOW_EXCEEDS_MAX` | Moss |
| 2 | 无限授权 | 口头批 100，calldata 请求 `uint256.max` | `APPROVAL_EXCEEDS_MAX` | Moss |
| 3 | 夹带授权 | 正常转账后偷偷追加一笔无限授权 | `UNDECLARED_APPROVAL` | Moss |
| 4 | 收款方掉包 | 金额不动，收款地址换成攻击者 | `UNDECLARED_RECIPIENT` | **自研** |
| 5 | 零宽字符掉包 | 展示地址夹不可见字符，肉眼与原地址一致 | `MISLEADING_ADDRESS` | **自研** |
| 6 | permit 重放 | 假 DEX"签名验证"实为 EIP-2612 permit 授权+抽干 | `PERMIT_REPLAY_RISK` | **自研** |
| 7 | 封印后篡改 | 计划封印后改写 `tx.to` | `PLAN_TAMPERED`（planHash 对不上） | Moss |

> 另有一条**兑换拦截**：用户说"把 MON 换成 USDC"时，MonadLens 不做真兑换（测试网无可用 DEX），而是当场演示"假 DEX 骗签名"的 permit 重放骗局——把最高发的钓鱼场景拆穿。

判定 `blocked` 时**签名按钮直接锁死**（不是提示，是拦住）。自研 warn 级两类在真实持币账户下表现为高风险告警；演示用零余额账户会触发 transferFrom revert，同样 `blocked`。

---

## 五、评分维度对照（建议评委关注）

| 维度 | MonadLens 对应证据 |
|---|---|
| 创新性 / Novelty | 在 Moss 之上补的三层自研盲区；把"Agent 效果 vs 链上真实效果"的信任盲区产品化 |
| 技术深度 / Technical | Next.js 16 + wagmi v3/viem v2；Moss `debug_traceCall` 真模拟；双脑 Agent（规则+LLM）确定性短路；per-endpoint 并发竞速 |
| 实用性 / Utility | 直接面向"盲签"高频风险；三栏一屏完成"看网络→说需求→看后果→签字" |
| 完成度 / Polish | tsc 通过；e2e 28 项全绿（15 agent + 3 normal + 8 attack + 2 chain）；已部署上线 |
| 演示 / Demo | 测试网真实签名上链、MonadScan 可验证；7 类攻击 + 兑换拆穿脚本化 |

---

## 六、现场怎么验

1. 打开已部署 URL → 左栏真实链上区块滚动（测试网）。
2. 点建议按钮或输入：「把 0.01 MON 包装成 WMON」跑通正常流程；「演示 permit 重放攻击」看自研盲区；「把收款地址换掉」看 `UNDECLARED_RECIPIENT` 锁死按钮。
3. 连钱包签名后到 MonadScan 验证（测试网免费代币）。

命令行自测：`python scripts/e2e.py <部署URL>`（需服务端可达）。

---

## 七、技术栈

Next.js 16（App Router）· React 19 · TypeScript · Tailwind v4 · wagmi v3 + viem v2 · zustand · recharts · **@themoss/core + @themoss/simulator**
Agent 双脑：规则引擎（确定性兜底）+ LLM（OpenAI 兼容，当前 glm-4-flash）。
Monad 测试网 chainId `10143` / 主网 `143`。

---

## 八、链接

- 仓库：`github.com/emptytouch/monadlens`
- 演示：Netlify 部署 URL（见提交页）
- 演示文稿：`MonadLens演示 · 透视链.pptx`（本仓库根目录，13 页）
- 详细说明：`README.md`
