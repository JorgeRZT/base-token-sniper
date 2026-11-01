// Usage: node scripts/latest-v3.js [count=20] [maxBlocksBack=100000]
// Uniswap V3 has no on-chain pool list, so we scan PoolCreated events via Infura (no contract needed).
const { Contract } = require("ethers");
const { ADDRESSES, getProvider, tokenInfo, pickNewToken } = require("../lib/config");

const CHUNK = 5000; // keep eth_getLogs ranges small to stay within provider limits

(async () => {
  const count = Number(process.argv[2] || 20);
  const maxBack = Number(process.argv[3] || 100000); // ~2.3 days on Base (2s blocks)
  const provider = getProvider();
  const factory = new Contract(
    ADDRESSES.V3_FACTORY,
    ["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"],
    provider
  );

  const head = await provider.getBlockNumber();
  const events = [];
  // Walk backwards from the head until we have enough pools.
  for (let to = head; to > head - maxBack && events.length < count; to -= CHUNK) {
    const from = Math.max(to - CHUNK + 1, 0);
    events.push(...(await factory.queryFilter(factory.filters.PoolCreated(), from, to)));
  }
  events.sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);
  const latest = events.slice(0, count);

  console.log(`Uniswap V3 on Base: ${latest.length} latest pools (head block ${head}):\n`);
  for (const ev of latest) {
    const { token0, token1, fee, pool } = ev.args;
    const fresh = pickNewToken(token0, token1);
    const info = await Promise.all([tokenInfo(provider, token0), tokenInfo(provider, token1)]);
    const f = fresh && info.find((t) => t.address.toLowerCase() === fresh.toLowerCase());
    console.log(`block ${ev.blockNumber}  pool ${pool}  fee ${Number(fee) / 10000}%`);
    console.log(`   ${info[0].symbol}/${info[1].symbol}` + (f ? `   -> new token: ${f.name} (${f.symbol}) ${f.address}` : ""));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
