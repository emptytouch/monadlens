import { NextResponse } from "next/server";
import { createPublicClient, http, fallback, formatEther, formatUnits, type Address } from "viem";
import { monad, MONAD_RPC_HTTP_LIST, tokenFromRef } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = createPublicClient({
  chain: monad,
  transport: fallback(MONAD_RPC_HTTP_LIST.map((u) => http(u))),
});

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    hash?: string;
    address?: string;
    tokens?: string[];
  };

  try {
    if (body.action === "explain_tx") {
      return NextResponse.json(await explainTx(body.hash ?? ""));
    }
    if (body.action === "address_summary") {
      return NextResponse.json(await addressSummary(body.address ?? ""));
    }
    if (body.action === "balances") {
      return NextResponse.json(await tokenBalances(body.address ?? "", body.tokens ?? []));
    }
    if (body.action === "network_stats") {
      return NextResponse.json(await networkStats());
    }
    return NextResponse.json({ ok: false, error: "未知的 action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "链上查询失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

async function explainTx(hash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return { ok: false, error: "交易哈希格式不对" };
  }
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: hash as `0x${string}` }),
    client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null),
  ]);

  const transfers = (receipt?.logs ?? [])
    .filter((log) => log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3)
    .slice(0, 6)
    .map((log) => {
      const meta = tokenFromRef(log.address);
      const raw = BigInt(log.data === "0x" ? "0x0" : log.data);
      return {
        token: meta.symbol,
        amount: formatUnits(raw, meta.decimals),
        from: `0x${log.topics[1]!.slice(26)}`,
        to: `0x${log.topics[2]!.slice(26)}`,
      };
    });

  const approvals = (receipt?.logs ?? []).filter((l) => l.topics[0] === APPROVAL_TOPIC).length;

  return {
    ok: true,
    kind: "explain_tx" as const,
    hash,
    from: tx.from,
    to: tx.to,
    value: formatEther(tx.value),
    blockNumber: tx.blockNumber?.toString() ?? null,
    status: receipt?.status ?? "unknown",
    gasUsed: receipt?.gasUsed?.toString() ?? null,
    isContractCall: Boolean(tx.input && tx.input !== "0x"),
    selector: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null,
    tokenTransfers: transfers,
    approvalCount: approvals,
    logCount: receipt?.logs.length ?? 0,
  };
}

async function addressSummary(address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { ok: false, error: "地址格式不对" };
  }
  const addr = address as Address;
  const [balance, nonce, code] = await Promise.all([
    client.getBalance({ address: addr }),
    client.getTransactionCount({ address: addr }),
    client.getCode({ address: addr }).catch(() => undefined),
  ]);
  return {
    ok: true,
    kind: "address_summary" as const,
    address: addr,
    balance: formatEther(balance),
    nonce,
    isContract: Boolean(code && code !== "0x"),
    codeSize: code ? (code.length - 2) / 2 : 0,
  };
}

/** Batch-fetch native + ERC-20 balances so the consequence panel can show a
 *  before/after balance delta. Each token read is isolated so one bad address
 *  can't sink the whole request. */
async function tokenBalances(address: string, tokens: string[]) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { ok: false, error: "地址格式不对" };
  }
  const addr = address as Address;
  const native = await client.getBalance({ address: addr }).catch(() => 0n);
  const items = await Promise.all(
    tokens
      .filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t))
      .map(async (t) => {
        try {
          const bal = await client.readContract({
            address: t as Address,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [addr],
          });
          return { token: t, balance: (bal as bigint).toString() };
        } catch {
          return { token: t, balance: "0" };
        }
      }),
  );
  return {
    ok: true,
    native: native.toString(),
    items,
  };
}

/** Monad blocks land in well under a second, so timestamps must be sampled
 *  across a window — differencing two adjacent blocks just rounds to zero. */
const BLOCK_TIME_WINDOW = 40n;
const TPS_WINDOW = 5;

async function networkStats() {
  const block = await client.getBlock({ blockTag: "latest", includeTransactions: false });
  const height = block.number ?? 0n;

  const anchorHeight = height > BLOCK_TIME_WINDOW ? height - BLOCK_TIME_WINDOW : 0n;
  const recentHeights = Array.from({ length: TPS_WINDOW - 1 }, (_, i) => height - BigInt(i + 1)).filter(
    (n) => n > 0n,
  );

  const [anchor, ...recent] = await Promise.all([
    client.getBlock({ blockNumber: anchorHeight }),
    ...recentHeights.map((blockNumber) => client.getBlock({ blockNumber, includeTransactions: false })),
  ]);

  const spanBlocks = Number(height - anchorHeight) || 1;
  const spanSeconds = Number(block.timestamp - anchor.timestamp);
  const blockTimeSec = spanSeconds > 0 ? spanSeconds / spanBlocks : null;

  const sampled = [block, ...recent];
  const avgTxPerBlock = sampled.reduce((sum, b) => sum + b.transactions.length, 0) / sampled.length;
  const tps = blockTimeSec ? avgTxPerBlock / blockTimeSec : null;

  return {
    ok: true,
    kind: "network_stats" as const,
    blockNumber: height.toString(),
    txCount: block.transactions.length,
    gasUsed: block.gasUsed.toString(),
    gasLimit: block.gasLimit.toString(),
    gasUsedPct: Number((Number(block.gasUsed) / Number(block.gasLimit)) * 100).toFixed(1),
    baseFeeGwei: block.baseFeePerGas ? Number(block.baseFeePerGas) / 1e9 : null,
    blockTimeSec: blockTimeSec ? Number(blockTimeSec.toFixed(3)) : null,
    avgTxPerBlock: Number(avgTxPerBlock.toFixed(1)),
    tps: tps ? Math.round(tps) : null,
  };
}
