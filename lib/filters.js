// Risk filters. Philosophy: flexible, score-based. Only clear-cut dangers are hard rejects;
// everything else subtracts points from a 0-100 score and the alert threshold (MIN_SCORE) is configurable.
const { Contract, id, zeroPadValue, getAddress } = require("ethers");
const { ADDRESSES } = require("./config");
const { checkImpersonation, norm } = require("./impersonation");
const { analyzeHolders } = require("./holders");
const { analyzeLp } = require("./lp");

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const cfg = () => ({
  minLiquidityUsd: num(process.env.MIN_LIQUIDITY_USD, 1000), // hard reject below this (when liquidity is known)
  minScore: num(process.env.MIN_SCORE, 40), // alert threshold (0-100)
  maxTaxPct: num(process.env.MAX_TAX_PCT, 25), // hard reject if buy/sell tax is above this
});

// Function selectors whose presence in the bytecode is a warning (not a rejection).
const RISKY = {
  mint: ["mint(address,uint256)", "mint(uint256)"],
  blacklist: ["blacklist(address)", "addBlacklist(address)", "setBlacklist(address,bool)", "blacklistAddress(address,bool)", "addToBlacklist(address)", "setBlacklisted(address,bool)"],
  pause: ["pause()", "setPaused(bool)"],
  taxControl: ["setFee(uint256)", "setTax(uint256)", "setFees(uint256,uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "setTaxes(uint256,uint256)"],
};
const SELECTORS = Object.fromEntries(
  Object.entries(RISKY).map(([k, sigs]) => [k, sigs.map((s) => id(s).slice(2, 10))])
);
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function honeypotIs(token) {
  try {
    const r = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=8453`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null; // 404 "pair not found" (e.g. every V4 pool) or API trouble => unknown
    const d = await r.json();
    if (!d.simulationSuccess && !d.honeypotResult) return null;
    return {
      isHoneypot: Boolean(d.honeypotResult?.isHoneypot),
      reason: d.honeypotResult?.honeypotReason || null,
      buyTax: d.simulationResult?.buyTax ?? null,
      sellTax: d.simulationResult?.sellTax ?? null,
      holders: d.token?.totalHolders ?? null,
    };
  } catch { return null; }
}

async function inspectContract(provider, token) {
  const out = { flags: [], owner: null, proxy: false };
  try {
    const code = (await provider.getCode(token)).toLowerCase();
    for (const [flag, sels] of Object.entries(SELECTORS)) {
      if (sels.some((s) => code.includes("63" + s))) out.flags.push(flag); // PUSH4 <selector>
    }
    const slot = await provider.getStorage(token, EIP1967_IMPL_SLOT);
    out.proxy = BigInt(slot) !== 0n;
  } catch {}
  try {
    const owner = await new Contract(token, ["function owner() view returns (address)"], provider).owner();
    out.owner = owner === ADDRESSES.NATIVE_ETH ? "renounced" : owner;
  } catch { out.owner = null; } // no owner() => not Ownable (or non-standard)
  return out;
}

/**
 * @param ctx.history  previous launches [{token, creator, sym, ts}] used for clone detection
 * @returns {{reject: string|null, score: number, level: string, reasons: string[], info: string[], ...}}
 */
async function evaluate({ provider, token, info, version, hooks, dex, pool, poolBlock, fromBlock, creator, token0, token1, fee, history = [] }) {
  const c = cfg();
  const reasons = [], notes = [];
  let score = 100;
  let reject = null;
  const sub = (pts, why) => { score -= pts; reasons.push(`-${pts} ${why}`); };
  const rej = (why) => { reject = reject || why; };

  // 1. Impersonation of known tokens / brands
  const imp = checkImpersonation({ address: token, name: info.name, symbol: info.symbol });
  if (imp.reject) rej(imp.reject);
  else if (imp.brand) sub(30, `uses the brand name "${imp.brand}"`);

  // 2. Clone detection: same creator or same symbol launched repeatedly in the last 48h
  const sym = norm(info.symbol);
  const byCreator = creator ? history.filter((h) => h.creator === creator.toLowerCase() && h.token !== token.toLowerCase()).length : 0;
  const bySymbol = sym ? history.filter((h) => h.sym === sym && h.token !== token.toLowerCase()).length : 0;
  const SIX_H = 6 * 3600 * 1000;
  const recentByCreator = creator ? history.filter((h) => h.creator === creator.toLowerCase() && h.token !== token.toLowerCase() && Date.now() - h.ts < SIX_H).length : 0;
  if (recentByCreator >= 5) rej(`serial deployer: ${recentByCreator} other tokens from the same creator in 6h`);
  if (byCreator >= 5) sub(30, `creator launched ${byCreator} other tokens in 48h (serial deployer)`);
  else if (byCreator >= 2) sub(15, `creator launched ${byCreator} other tokens in 48h`);
  if (bySymbol >= 1) sub(15, `symbol "${info.symbol}" already launched ${bySymbol}x in 48h (clone)`);

  // 3. Liquidity (DexScreener)
  if (dex?.liquidityUsd != null) {
    if (dex.liquidityUsd < c.minLiquidityUsd) rej(`liquidity $${Math.round(dex.liquidityUsd)} < min $${c.minLiquidityUsd}`);
    else if (dex.liquidityUsd < 5000) sub(10, `low liquidity ($${Math.round(dex.liquidityUsd)})`);
  } else sub(10, "liquidity unknown (not indexed)");

  // 4. Honeypot simulation (V2/V3 only; V4 pools are not supported by the API)
  const hp = await honeypotIs(token);
  if (hp) {
    if (hp.isHoneypot) rej(`honeypot${hp.reason ? ` (${hp.reason})` : ""}`);
    const maxTax = Math.max(hp.buyTax ?? 0, hp.sellTax ?? 0);
    if (maxTax > c.maxTaxPct) rej(`tax ${maxTax}% > max ${c.maxTaxPct}%`);
    else if (maxTax > 10) sub(20, `high tax (buy ${hp.buyTax}% / sell ${hp.sellTax}%)`);
  } else sub(10, version === "v4" ? "sell simulation not available for V4" : "sell simulation unavailable");

  // 5. Contract inspection
  const contract = await inspectContract(provider, token);
  const penalties = { mint: 15, blacklist: 15, pause: 10, taxControl: 5 };
  for (const f of contract.flags) sub(penalties[f], `contract can ${f === "taxControl" ? "change taxes" : f === "mint" ? "mint tokens" : f === "blacklist" ? "blacklist wallets" : "pause transfers"}`);
  if (contract.proxy) sub(15, "upgradeable proxy");
  if (contract.owner && contract.owner !== "renounced") sub(5, "owner not renounced");

  // 6. V4 hook = custom logic can run on every swap
  if (hooks) sub(15, `V4 hook ${hooks.slice(0, 10)}…`);

  // 7. Holder distribution (rebuilt from Transfer events; works for V2/V3/V4)
  const excluded = [pool, ADDRESSES.V4_POOL_MANAGER].filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const holders = await analyzeHolders(provider, { token, fromBlock, excluded, creator });
  if (holders) {
    const conc = Math.max(holders.topHolderPct, holders.creatorPct);
    if (conc >= 50) sub(20, `one wallet holds ${conc}% of the supply`);
    else if (conc >= 20) sub(10, `one wallet holds ${conc}% of the supply`);
    if (holders.holders < 5) sub(5, `only ${holders.holders} holders`);
  } else sub(5, "holder distribution unavailable");

  // 8. LP position: burned / locked / held by a wallet
  const lp = await analyzeLp(provider, { version, pool, token0, token1, fee, fromBlock: poolBlock });
  if (lp?.removed) rej("liquidity was removed after being added (rug pull)");
  else if (!lp) sub(5, "LP ownership unknown (no liquidity or not readable)");
  else if (lp.lockedPct >= 80) notes.push(`LP ${lp.lockedPct}% burned/locked`);
  else if (lp.walletPct >= 50 && (version === "v2" || version === "v3")) rej(`${version.toUpperCase()} LP ${lp.walletPct}% in a wallet (such V2/V3 pools keep pulling liquidity within hours)`);
  else if (lp.walletPct >= 50 && version === "v4") sub(5, `${lp.walletPct}% of the LP is in a wallet (rarely pulled in V4)`);
  else if (lp.walletPct >= 50) sub(20, `${lp.walletPct}% of the LP is in a wallet (liquidity can be pulled)`);
  else if (lp.contractPct >= 50) sub(5, `${lp.contractPct}% of the LP is in a contract (verify it is a locker)`);
  else sub(10, `LP split: ${lp.lockedPct}% locked, ${lp.contractPct}% contract, ${lp.walletPct}% wallet`);

  score = Math.max(0, score);
  const level = reject ? "🔴 REJECT" : score >= 70 ? "🟢 LOW RISK" : score >= c.minScore ? "🟡 MEDIUM RISK" : "🟠 HIGH RISK";
  return { reject, score, level, reasons, notes, honeypot: hp, contract, holders, lp, brand: imp.brand, passes: !reject && score >= c.minScore };
}

module.exports = { evaluate, cfg };
