import { defineChain } from "viem";

/**
 * Network is selected at build time via NEXT_PUBLIC_MONAD_NETWORK.
 *   "mainnet" (default) -> chain id 143, real MON, no faucet
 *   "testnet"           -> chain id 10143, free faucet MON at https://faucet.monad.xyz
 *
 * Everything downstream (chain id, RPC, explorer, token addresses, agent
 * system prompt) is derived from this single switch, so flipping the network
 * is a one-line env change + rebuild.
 */
export const MONAD_NETWORK = (process.env.NEXT_PUBLIC_MONAD_NETWORK ?? "mainnet").toLowerCase();
export const MONAD_IS_TESTNET = MONAD_NETWORK === "testnet";
export const MONAD_NETWORK_LABEL = MONAD_IS_TESTNET ? "Monad 测试网" : "Monad 主网";

export const MONAD_CHAIN_ID: number = MONAD_IS_TESTNET ? 10143 : 143;

/** Free testnet faucet — null on mainnet (MON is a real asset there). */
export const MONAD_FAUCET_URL: string | null = MONAD_IS_TESTNET ? "https://faucet.monad.xyz" : null;

/**
 * RPC endpoints are configurable + multi-endpoint so the app degrades
 * gracefully when the public node is slow or unreachable.
 *
 * Override via env (comma-separated, first entry is primary):
 *   Mainnet:  NEXT_PUBLIC_MONAD_RPC_URLS / NEXT_PUBLIC_MONAD_RPC_WS_URLS
 *   Testnet:  NEXT_PUBLIC_MONAD_TESTNET_RPC_URLS / NEXT_PUBLIC_MONAD_TESTNET_RPC_WS_URLS
 *
 * viem's fallback() transport automatically switches to the next URL when
 * the previous one errors or times out.
 */
function parseRpcList(envValue: string | undefined, fallbackUrl: string): string[] {
  const raw = (envValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length > 0 ? raw : [fallbackUrl];
}

const MAINNET_RPC_HTTP_DEFAULT = "https://rpc.monad.xyz";
const MAINNET_RPC_WS_DEFAULT = "wss://rpc.monad.xyz";
const TESTNET_RPC_HTTP_DEFAULT = "https://testnet-rpc.monad.xyz";
const TESTNET_RPC_WS_DEFAULT = "wss://testnet-rpc.monad.xyz";

export const MONAD_RPC_HTTP_LIST = parseRpcList(
  MONAD_IS_TESTNET ? process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URLS : process.env.NEXT_PUBLIC_MONAD_RPC_URLS,
  MONAD_IS_TESTNET ? TESTNET_RPC_HTTP_DEFAULT : MAINNET_RPC_HTTP_DEFAULT,
);
export const MONAD_RPC_WS_LIST = parseRpcList(
  MONAD_IS_TESTNET ? process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_WS_URLS : process.env.NEXT_PUBLIC_MONAD_RPC_WS_URLS,
  MONAD_IS_TESTNET ? TESTNET_RPC_WS_DEFAULT : MAINNET_RPC_WS_DEFAULT,
);
// Primary endpoints (kept for callers that need a single URL, e.g. Moss runtime).
export const MONAD_RPC_HTTP = MONAD_RPC_HTTP_LIST[0];
export const MONAD_RPC_WS = MONAD_RPC_WS_LIST[0];

const EXPLORER_BASE = MONAD_IS_TESTNET ? "https://testnet.monadexplorer.com" : "https://monadscan.com";

/** Hex chainId string for wallet_addEthereumChain / wallet_switchEthereumChain. */
export const MONAD_CHAIN_ID_HEX = `0x${MONAD_CHAIN_ID.toString(16)}`;

/**
 * Parameters for EIP-3085 wallet_addEthereumChain. Used by the "add network"
 * button so the user never has to manually configure RPC / explorer.
 */
export const MONAD_ADD_CHAIN_PARAMS = {
  chainId: MONAD_CHAIN_ID_HEX,
  chainName: MONAD_NETWORK_LABEL,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: MONAD_RPC_HTTP_LIST,
  blockExplorerUrls: [EXPLORER_BASE],
  iconUrls: ["https://monad.xyz/favicon.ico"],
};

export const monad = defineChain({
  id: MONAD_CHAIN_ID,
  name: MONAD_NETWORK_LABEL,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: MONAD_RPC_HTTP_LIST, webSocket: MONAD_RPC_WS_LIST },
  },
  blockExplorers: {
    default: { name: MONAD_IS_TESTNET ? "MonadExplorer (Testnet)" : "MonadScan", url: EXPLORER_BASE },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export type TokenMeta = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
};

/** Canonical mainnet tokens, verified against Monad's official docs. */
const MAINNET_TOKENS: Record<string, TokenMeta> = {
  WMON: {
    symbol: "WMON",
    name: "Wrapped MON",
    address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    decimals: 18,
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    decimals: 6,
  },
  WETH: {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
    decimals: 18,
  },
  AUSD: {
    symbol: "AUSD",
    name: "Agora Dollar",
    address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    decimals: 6,
  },
  WSOL: {
    symbol: "WSOL",
    name: "Wrapped SOL",
    address: "0xea17E5a9efEBf1477dB45082d67010E2245217f1",
    decimals: 9,
  },
};

/** Testnet tokens (chainId 10143), from Monad's developer docs tokenlist. */
const TESTNET_TOKENS: Record<string, TokenMeta> = {
  WMON: {
    symbol: "WMON",
    name: "Wrapped MON (Testnet)",
    address: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701",
    decimals: 18,
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin (Testnet)",
    address: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea",
    decimals: 6,
  },
  USDT: {
    symbol: "USDT",
    name: "Tether (Testnet)",
    address: "0x88b8E2161DEDC77EF4ab7585569D2415a1C1055D",
    decimals: 6,
  },
  WETH: {
    symbol: "WETH",
    name: "Wrapped Ether (Testnet)",
    address: "0xB5a30b0FDc5EA94A52fDc42e3E9760Cb8449Fb37",
    decimals: 18,
  },
  WSOL: {
    symbol: "WSOL",
    name: "Wrapped SOL (Testnet)",
    address: "0x5387C85A4965769f6B0Df430638a1388493486F1",
    decimals: 9,
  },
};

export const TOKENS: Record<string, TokenMeta> = MONAD_IS_TESTNET ? TESTNET_TOKENS : MAINNET_TOKENS;

export const NATIVE_TOKEN: TokenMeta = {
  symbol: "MON",
  name: "Monad",
  address: "0x0000000000000000000000000000000000000000",
  decimals: 18,
};

export function findToken(query: string): TokenMeta | undefined {
  const q = query.trim();
  if (!q) return undefined;
  if (q.toLowerCase() === "mon" || q.toLowerCase() === "native") return NATIVE_TOKEN;
  const bySymbol = TOKENS[q.toUpperCase()];
  if (bySymbol) return bySymbol;
  const lower = q.toLowerCase();
  return Object.values(TOKENS).find((t) => t.address.toLowerCase() === lower);
}

/** Resolve a Moss TokenRef ("native" | address) back to display metadata. */
export function tokenFromRef(ref: string): TokenMeta {
  if (ref === "native") return NATIVE_TOKEN;
  const lower = ref.toLowerCase();
  const known = Object.values(TOKENS).find((t) => t.address.toLowerCase() === lower);
  return (
    known ?? {
      symbol: `${ref.slice(0, 6)}…${ref.slice(-4)}`,
      name: "Unknown token",
      address: ref as `0x${string}`,
      decimals: 18,
    }
  );
}

export const explorerTx = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${EXPLORER_BASE}/address/${addr}`;
export const explorerBlock = (n: bigint | number) => `${EXPLORER_BASE}/block/${n}`;
