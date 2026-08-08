import { formatUnits } from "viem";

export function shortAddr(addr?: string | null, size = 4): string {
  if (!addr) return "—";
  if (addr.length <= 2 + size * 2) return addr;
  return `${addr.slice(0, 2 + size)}…${addr.slice(-size)}`;
}

/** Format base units into a compact human string, trimming trailing zeros. */
export function formatAmount(base: bigint | string, decimals: number, maxFrac = 6): string {
  const v = typeof base === "string" ? BigInt(base) : base;
  const raw = formatUnits(v, decimals);
  const [int, frac = ""] = raw.split(".");
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  const intPretty = BigInt(int).toLocaleString("en-US");
  return trimmed ? `${intPretty}.${trimmed}` : intPretty;
}

/** Unlimited ERC-20 approvals are 2^256-1; show them as what they are. */
const MAX_UINT256 = (1n << 256n) - 1n;
export function isUnlimited(amount: bigint | string): boolean {
  const v = typeof amount === "string" ? BigInt(amount) : amount;
  return v >= MAX_UINT256 / 2n;
}

export function formatApproval(amount: string, decimals: number): string {
  return isUnlimited(amount) ? "无限额度" : formatAmount(amount, decimals);
}

export function formatGwei(wei: bigint | string): string {
  const v = typeof wei === "string" ? BigInt(wei) : wei;
  return (Number(v) / 1e9).toFixed(2);
}

export function formatNumber(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
