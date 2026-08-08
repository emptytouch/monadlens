import { createPublicClient, webSocket, http } from "viem";
const WS = "wss://rpc.monad.xyz";
const HTTP = "https://rpc.monad.xyz";

console.log("[1] 测试 WebSocket 订阅...");
const t0 = Date.now();
try {
  const c = createPublicClient({ transport: webSocket(WS, { timeout: 10000, retryCount: 1 }) });
  const n = await c.getBlockNumber();
  console.log(`    WS getBlockNumber OK: #${n} (${Date.now() - t0}ms)`);

  let got = 0;
  const un = c.watchBlocks({
    includeTransactions: true,
    emitOnBegin: true,
    onBlock: (b) => { got++; if (got <= 3) console.log(`    收到区块 #${b.number} (${b.transactions.length} 笔) @${Date.now() - t0}ms`); },
    onError: (e) => console.log("    watchBlocks onError:", e.message.slice(0, 120)),
  });
  await new Promise((r) => setTimeout(r, 9000));
  un();
  console.log(`    9 秒内共收到 ${got} 个区块`);
} catch (e) {
  console.log("    WS 失败:", e.message.slice(0, 200));
}

console.log("[2] 测试 HTTP 轮询...");
try {
  const c = createPublicClient({ transport: http(HTTP) });
  const t = Date.now();
  const b = await c.getBlock({ blockTag: "latest", includeTransactions: true });
  console.log(`    HTTP OK: #${b.number}, ${b.transactions.length} 笔, ${Date.now() - t}ms`);
} catch (e) {
  console.log("    HTTP 失败:", e.message.slice(0, 200));
}
process.exit(0);
