// Rebuilds token balances from Transfer events (the token is new, so the history is short).
const { Interface, id, getAddress } = require("ethers");

const TRANSFER = id("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const iface = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/**
 * @param excluded addresses that hold tokens by design (pool, PoolManager...) and are not "holders"
 * @returns null if the history cannot be rebuilt, else {holders, topHolderPct, topHolder, creatorPct}
 */
async function analyzeHolders(provider, { token, fromBlock, excluded = [], creator }) {
  let logs;
  try {
    logs = await provider.getLogs({ address: token, topics: [TRANSFER], fromBlock, toBlock: "latest" });
  } catch { return null; }

  const bal = new Map();
  let minted = 0n;
  for (const log of logs) {
    let e; try { e = iface.parseLog(log); } catch { continue; }
    const from = e.args.from.toLowerCase(), to = e.args.to.toLowerCase(), v = e.args.value;
    if (from === ZERO) minted += v; else bal.set(from, (bal.get(from) || 0n) - v);
    bal.set(to, (bal.get(to) || 0n) + v);
  }
  if (minted === 0n) return null; // token does not emit mint events: cannot trust the reconstruction

  const skip = new Set([ZERO, DEAD, ...excluded.map((a) => a.toLowerCase())]);
  let holders = 0, top = 0n, topHolder = null;
  for (const [addr, b] of bal) {
    if (b <= 0n || skip.has(addr)) continue;
    holders++;
    if (b > top) { top = b; topHolder = addr; }
  }
  const pct = (b) => Number((b * 10000n) / minted) / 100;
  const cb = creator ? bal.get(creator.toLowerCase()) || 0n : 0n;
  return {
    holders,
    topHolder: topHolder && getAddress(topHolder),
    topHolderPct: pct(top),
    creatorPct: pct(cb > 0n ? cb : 0n),
  };
}

module.exports = { analyzeHolders };
