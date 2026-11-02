# Findings (most revealing data from the analyses so far)

_Read this together with `docs/STATE.md` at the start of a session._ `data/` is git-ignored, so the numbers that matter are kept here.
All times UTC. Data window of this file: **2026-11-01 12:33 to 2026-11-02 ~07:30** (~19 h, ~1,370 evaluated tokens). **No 24 h checkpoints existed yet** when these were written (the first ones arrive ~12:30Z on 2026-11-02): update this file after them.

Everything below was found by looking at the same data, so it is **in-sample and not validated forward**. Re-run `node scripts/analyze.js` (see "How to reproduce") before relying on any number.

## Definitions used
- **Alert / alert price**: a token that passes the filter (score >= 40, no hard reject). Alert price = DexScreener price when the bot evaluates it (up to `DEX_WAIT_MIN` = 5 min after the pool appears); if it was not indexed yet, the first price sampled afterwards (`baselinePriceUsd`).
- **Serial deployer**: a creator with >= 5 launches in the analysed dataset (live filter: 5+ other tokens from the same creator in 6 h = hard reject).
- **Peak**: highest price seen after the alert, sampled every ~1-3 min. Only reliable for tokens evaluated after **17:45Z on 2026-11-01** (peak tracking started ~17:41Z). Earlier tokens only have 1h/6h/24h prices (a lower bound of the peak).
- **x** = price divided by the alert price. "Unpriced" alerts = never indexed by DexScreener, so no price exists.

## 1. Volume and funnel
- ~1,700-2,100 new tokens/day on Base; **~93% are Uniswap V4** (V2 ~15%, V3 ~2% of all evaluated tokens).
- Of 1,364 tokens: 411 alerted (30%), **953 not alerted**: 647 hard rejects (322 serial deployer, 175 V2 with LP in a wallet, 86 liquidity removed = rug, 40 liquidity < $1,000, 10 impersonation of cbBTC/AERO/WBTC/USDT, 14 generic names like BTC/LUSD) + 306 with score < 40.
- With the final filter the bot alerts ~450/day (replay of the final filter on all data: 470 alerts, ~600/day). Only ~10 of ~265 alerts (since 15:45Z) later peaked >= 2x: **alerts are mostly noise**; of 220 still indexed, median price vs alert = 1.00x, 155 flat (0.8-1.2x), 14 >= 2x, 4 below 0.8x (2 dead).

## 2. Which filters were validated by outcomes
| Rule | Evidence |
|---|---|
| V2 with >= 50% of the LP in a wallet = reject | Before the rule: 17 of 17 V2 passers collapsed (liquidity < 20% of start); after it, 155 of 160 rejected V2 with data collapsed at 1h. The V2 "rug template" is ~$7k-$68k liquidity, LP 100% in a wallet, honeypot.is passes (score 60-80). |
| Serial deployer (5+ in 6 h) = reject | 28 creators / 607 tokens: 0 liquidity collapses, 0 pumps >= 2x, only 2 tokens with 24h volume > $1,000 (zombie tokens, LP always in a contract). |
| V3 with >= 50% of the LP in a wallet = reject (added 2026-11-02) | Weak: ~$18k pools WBUT, LZRD, LEAR went to 0 liquidity, but only 3 of 11 V3 with data collapsed (rest had no 6h data, e.g. the 15 tokens of creator `0x18c4ec54`). Re-check with 24h data. |
| V4 LP in a wallet: penalty -20 -> -5 (added 2026-11-02) | V4 liquidity collapses are rare: 2 of 568 at 1h, 3 of 312 at 6h. The tokens that pump most are exactly V4 with LP in a wallet, low liquidity (~$2k) and few holders. |
| Passed-and-collapsed after the 2026-11-01 15:45Z change | 0 of 148 V4 at 1h, 0 of 105 at 6h; remaining failures were V3/V2 (see above). |

## 3. The score is inversely related to pumps (the main surprise)
Clean peak data, non-serial tokens evaluated after 17:45Z, peak within 1 h of the alert:
| Score at alert | Tokens | Peak >= 2x | Peak >= 5x |
|---|---|---|---|
| < 40 | 77 | **50** | 36 |
| 40-59 | 123 | 8 | 7 |
| >= 60 | 32 | 0 | 0 |
| Rejected | 233 | 55 | 8 (but 124 fell below 0.5x, mostly V2) |
Excluding the `0xd54345` actor (section 5): score < 40 -> 37 of 58 peaked >= 2x vs 7 of 153 for score >= 40. The penalties that sink these tokens (no V4 sell simulation, LP in a wallet, hooks, few holders) do not separate winners from losers in V4. Pumps happen ~10-30 min after the alert and the price then stays near the peak.

## 4. Family "B2": addresses starting with `0xb2000000…`
- 134 tokens so far, ~7 launches/hour, 113+ different creators, V4, initial liquidity ~$2.3-2.4k (fixed starting price ~$0.0000023), LP 100% in a wallet. Looks like a launcher/factory template. Not identified on-chain.
- 87 would be alerted by the final filter (20 were actually alerted at the time); 47 discarded: 24 liquidity < $1,000 (a different template, median 1.6x, max 2.0x), 10 score < 40, 8 serial (flat), 3 generic names (BTC/USD, pumped median 4.3x), 2 impersonation.
- Alerted-with-final-filter performance (clean peak data, 55 tokens): **peak mean 7.0x, median 7.5x, max 16.2x** (FOTF, alerted 04:38Z, peak 33 min later); 44 of 55 reached >= 2x, 11 stayed flat. Time to peak: median 26 min, mean 27, p90 30 (one outlier 336). Price at 1h (79 tokens): median 5.7x, 64 >= 2x, 47 >= 5x, 1 below 1x (MEOW 0.9x). At 6h (56 tokens): median 5.8x.
- After ~30 min the price stops moving: of 83 B2 tokens older than 6 h, 81 had 0 transactions in the last hour; 75 still have >= 80% of the initial liquidity and 42 have more than twice (buyers' money stays in the pool). **No liquidity pull in 110 tokens with known liquidity.**
- The 20 actually alerted: 1h median 6.6x, 10 of 15 with data >= 2x, 5 flat. The flat ones were off the usual pattern (liquidity $4k-$765k, or never indexed); the typical ~$2.3k launches behaved like the rest.
- Caveat: the "x" prices are last-trade prices of pools of $2-10k; a sell of any size moves them, V4 has no sell simulation here, and hooks could tax. Nothing was validated forward.

## 5. Actor "D5": LP owner `0xd54345CA46bFB6B44fE6c6eE9B9ccB3838Db680F`
- 54 V4 tokens (54 creators) between 12:33Z and 21:26Z, 5-7 per hour, then **stopped (dormant since 2026-11-01 21:26Z)**. ~$2.3-6.6k liquidity, one wallet holds 96.79% of the supply, 111-130 holders, no hook.
- 36 of 54 reached >= 2x at 1h (median 2.35x, max 2.75x), none below 0.5x, 2 of 42 liquidity drops; peak ~7-13 min after the alert (3-13 min, median 10). Median 24h volume $76k on ~$9k pools, identical at 1h and 6h: looks programmatic/artificial. Not identified.

## 6. Anakin: the one organic winner
`0x8EE421C2dd577EA6c7699d225c156017265DEB14` ("Anakin Skywalker", V4 with a hook, score 40 = the bare minimum). Alerted 2026-11-02 02:34Z at liquidity $8k. Peak **35.2x** at 24 min, 6.7x at 1h, 22.8x at ~07:00Z; liquidity $8k -> $64k; 2,479 transactions in 6 h ($848k volume) but none in the last hour. It had penalties for clone symbol, no sell simulation, hook and LP 100% in a wallet: a stricter threshold would have missed it.

## 7. Simulation: 1 cent in every alert, value now vs alert price (~07:00Z 2026-11-02)
| Set | Result |
|---|---|
| Alerts since 15:45Z (288; unpriced counted as lost) | $2.88 -> $3.55 = **+23%** (+48% if unpriced are excluded) |
| Same, without Anakin | +16% |
| Same, without the B2 family and the D5 actor | **+2%** (-6% also without Anakin) |
| All 410 alerts since the start | +21% |
| Replay of the final filter on all tokens (449 alerts > 1h old) | +101%, but family B2 alone (80 alerts) +506%, actor D5 (53) +108%; without them -3% |
Almost all profit comes from ~10 alerts. 48 of 288 alerts since 15:45Z had no price (never indexed).

## 8. Other observations
- The score is dominated by constant penalties for every V4 token (-10 "sell simulation not available", often -15 hook, -5 few holders), which compresses V4 scores (20-50) and inflates V2/V3.
- Impersonation is common (cbBTC, LUSD, WBTC, USDT, SpaceX, Anthropic, "Federal Fund Dividend" clones); symbol "Anakin" was launched 5+ times in 48 h; the empty symbol "?" appears in 21+ alerts (different contracts).
- Infura public RPC limits `eth_getLogs`; DexScreener batch endpoint `tokens/v1/base/{a,b,...}` accepts 30 addresses and only returns indexed tokens.
- Telegram: a bare channel username in `TELEGRAM_CHAT_ID` (no `@`) used to fail with "chat not found"; `lib/telegram.js` now prefixes `@`.

## Open questions (to answer with 24 h data and forward tests)
1. Do the B2 and D5 patterns persist (D5 is dormant) or were they a coincidence of the first 19 h? Forward paper-trading test needed before any buy logic.
2. How much of the move can be captured with a reaction delay? `outcomes.jsonl` now stores the price at +2/+5/+10/+15/+30 min (`path`) since 2026-11-02 ~07:15Z; `analyze.js` prints a "Reaction time" block once there is data.
3. Can the family hold time/multiple (hard-coded in `lib/families.js`) be recalibrated, and is selling possible at those prices (V4 sell simulation not implemented)?
4. Do the V3 and V4 rule changes hold at 24 h?

## How to reproduce
- `node scripts/analyze.js [--serial-min N] [--since ISO_DATE]`: all tokens / serial / non-serial / per version, 1h-6h-24h outcomes, peaks, false positives, reaction time. Use `--since 2026-11-01T17:45:00Z` for clean peak data and `--since 2026-11-01T15:45:00Z` for the filter after the first change.
- Per-token joins used here: `data/new-tokens.jsonl` (`alerted`, `verdict`, `dexscreener`, `creator`, `family`) with `data/outcomes.jsonl` (`checkpointHours`, `priceUsd`, `baselinePriceUsd`, `peakPriceUsd`, `peakPriceAfterMin`, `minPriceUsd`, `path`) and a live DexScreener batch query for "now" prices. These ad-hoc joins were temporary scripts; the main parts live in `scripts/analyze.js`.
- `node scripts/alert-preview.js [--send]`: shows (and optionally sends to Telegram) a sample alert for an isolated token and a family token.
