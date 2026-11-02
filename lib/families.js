// Known token "families": groups of tokens that launch and behave alike. When an alerted token belongs to one,
// the notification shows the family, how long to hold and the multiple the family has historically reached.
//
// IMPORTANT (2026-11-02 backtest, scripts/trade-backtest.js): buying at the alert block and selling through the real pools
// showed that 13 of 17 B2 pools (per-token hook, fee 100, tickSpacing 1) return 0% on a sale at the alert block and at +27 min,
// and the sellable ones (hook 0x1f91c998 or none) returned ~98% (flat). Anakin has the same pattern. The multiples below
// are last-trade prices on DexScreener of pools that cannot be sold: they were NOT realizable, so the families are marked
// `tradable: false` (alerts warn instead of suggesting a hold time, no sell alerts, no auto-trading).
//
// The statistics below are historical (first ~19 h of data, 2026-11-01 12:33Z to 2026-11-02 07:30Z, measured from the price
// at alert time) and were found by looking at the same data, so they are NOT validated forward. Recalibrate them with
// `node scripts/analyze.js` once more data (24 h checkpoints, price path) is available.
const FAMILIES = [
  {
    id: "B2",
    tradable: false,
    warning: "backtest: 13 of 17 pools of this family returned 0% on a sale (hook blocks selling); the sellable ones stayed flat (~0.98x)",
    name: "B2 launcher",
    describe: "address starts with 0xb2000000…",
    match: (r) => /^0xb2000000/i.test(r.token.address),
    holdMin: 27, // median minutes from alert to the price peak (median 26, mean 27, p90 30; 55 tokens with tracked peaks)
    holdRange: "25-30",
    expectedPeak: 7.5, // median peak / alert price (mean 7.0, 44 of 55 reached >= 2x)
    expectedConservative: 5.7, // median price at 1h / alert price (79 tokens)
    history: "44 of 55 reached ≥2× · liquidity never pulled (0 of 110)",
    usualLiquidity: [1500, 3000], // initial liquidity of the usual template (~$2.3k)
    offTemplate: "usual launch has ~$2.3k liquidity; 3 of the 4 launches with more stayed flat",
    note: "price stops moving after the peak (no trades), sell on time",
  },
  {
    id: "D5",
    tradable: false,
    warning: "same pattern as B2 (per-token hook pools); sell simulation needed before any trade",
    name: "D5 pool owner",
    describe: "LP owned by 0xd54345…",
    match: (r) => (r.verdict?.lp?.topOwner || "").toLowerCase().startsWith("0xd54345"),
    holdMin: 10, // median minutes to peak (21 tokens with tracked peaks: 3-13 min)
    holdRange: "8-13",
    expectedPeak: 2.4, // median peak / alert price
    expectedConservative: 2.35, // median price at 1h / alert price (54 tokens)
    history: "36 of 54 reached ≥2× · none above 2.8× · none dropped",
    note: "dormant: no launches since 2026-11-01 21:26Z",
  },
];

/** @returns the first family the alert record belongs to, or null (isolated token). */
function classifyFamily(record) {
  return FAMILIES.find((f) => { try { return f.match(record); } catch { return false; } }) || null;
}

module.exports = { FAMILIES, classifyFamily };
