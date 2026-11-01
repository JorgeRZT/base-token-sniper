# Project state (read this first in a new session)

_Last updated: 2026-11-01 (evening)._

## Goal
A "Base token sniper" **detection** bot: find freshly deployed tokens on Uniswap V2/V3/V4 on Base, score risk, alert on Telegram. Buying is out of scope for now. The user wants flexible filters (accept some risk: many tokens pump within hours or days).

## What exists and works (tested against Base mainnet via the user's Infura key)
- `scripts/monitor.js`: one pass, designed for cron every 60 s. Detects pools (V2/V3/V4), freshness check, DexScreener enrichment, risk scoring, Telegram alerts, 1h/6h/24h follow-up.
- Filters (docs/FILTERS.md): impersonation, clones (creator/symbol, 48h), liquidity, honeypot.is, bytecode flags, proxy, owner, V4 hooks, holder concentration, LP ownership (burned/contract/wallet), liquidity-removed = rug pull (hard reject).
- The earlier smart contract (`RecentPairsReader`) was **removed** from the project (the bot does not need it). It remains deployed on Base at `0x7aDE98D9aA5A797a9cE1198607d50b1471cb4d82`; harmless. The user's `.env` may still contain an unused `PRIVATE_KEY` that they were advised to delete.

## Repository
Published at https://github.com/JorgeRZT/base-token-sniper (public, branch `main`, MIT, topics and issue labels configured). `.env` and `data/` are git-ignored; never commit secrets.

## Not done / pending
- **Telegram is not configured yet** (the user will set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`); sending to Telegram has never been tested end to end.
- The user is about to run the bot ~24 hours via cron and will share `data/new-tokens.jsonl` (and `data/outcomes.jsonl`) for review.

## First analysis (3 h of data, 273 tokens) and filter changes
- All 12 V2 tokens that passed had 100% of the LP in a wallet and removed liquidity within 1h; V4 passers collapsed 1/41. Serial deployers (9 creators, 55% of tokens) are 100% V4, LP in a contract, and show no pump nor rug (zombie tokens); rugs and pumps come from non-serial creators.
- Applied (`lib/filters.js`, after ~16:40 local on 2026-11-01): V2 with >=50% LP in a wallet = hard reject; 5+ other tokens from the same creator in 6h = hard reject; brand name penalty -10 -> -30. Data before/after this change is not directly comparable.

## How to repeat the analysis (including serial deployers)
Run `node scripts/analyze.js` from the project root (options: `--serial-min N`, default 5; `--since ISO_DATE`). It prints, for ALL tokens, SERIAL creators, NON-SERIAL creators and each Uniswap version: level/score distribution, pass and alert counts, reject reasons, LP owner kind, median liquidity, and per checkpoint (1h/6h/24h) the liquidity collapse rate, liquidity growth, price >=2x/>=5x, volume and the false-positive rate (passed but collapsed). It ends with a per-creator table of the serial deployers.
- "Serial" = a creator with >= N launches **in the analysed dataset**, so it is computed from the data and does not depend on the live filter. Serial tokens are still evaluated and logged after the filter change, just rejected, so they stay in the comparison.
- To get a clean before/after view of the 2026-11-01 filter change use `--since` with the first detection after the change (the first serial-deployer reject in `new-tokens.jsonl` marks it). Without it, the old and new filters are mixed.
- Baseline from the first 3 h (pre-change; 273 tokens): serial = 152 tokens / 9 creators, 100% V4, LP in a contract, 0/30 liquidity collapses, 0 pumps >=2x, 36 of 42 found with 24h volume under $10 (zombie tokens). Non-serial = 125 tokens / 115 creators, 13/63 collapses, 20/72 pumps >=2x, 54 with volume over $1,000.
- Caveats: tokens not indexed in DexScreener at detection have no baseline price (STEEM x7.6 and UPVEMBER x5.8 are serial and were left out of the pump count); the 1h checkpoint only samples the price at that moment, not the peak (consider recording the maximum).

## Next steps (after the 24 h run)
1. Run `node scripts/analyze.js` and review the output (and read the jsonl for details): how many tokens evaluated/passed per day (the estimate was ~300-450 passing per day at `MIN_SCORE=40`, from a single 30-min sample), the score distribution, the false-positive rate (passed but rugged: compare `outcomes.jsonl` at 1h/6h/24h) and tokens that pumped.
2. Tune `MIN_SCORE`, penalties and thresholds with that data; consider fewer alerts (e.g. `MIN_SCORE=60`).
3. Ideas discussed: penalty for tokens with a single holder or LP in a wallet, flag implausible DexScreener liquidity (a clone showed $30M), recognise common locker contracts (`LOCKER_ADDRESSES`), delayed alerts to filter early rugs (many rugs happen 8-30 min after launch), WebSocket instead of polling, V3 manual-listing tool cleanup.

## Observations so far
- Base V2 gets ~200-270 new pairs/day; across V2+V3+V4 about 1,700 pools/day were seen in a 30 min sample (V4 is more than half).
- In a 30 min sample: 18 fresh tokens evaluated, 9 passed (score >= 40), 6 had already removed liquidity (rug pulls, mostly V4).
- Many tokens are clones/impersonations (cbBTC, LUSD, SpaceX, Anthropic, "Federal Fund Dividend" series).
- honeypot.is does not support V4 pools; gas on Base/Ethereum/Arbitrum is negligible (fractions of a cent), so the chain choice depends on opportunity and bot competition (Base was kept).
- Infura public RPC rate limits eth_getLogs; the user's Infura key works for Base.

## Conventions
- Everything (code, docs, comments) in **English**; conversation with the user in Spanish.
- Never read or print the user's `.env` (it holds secrets). Do not add private keys or trading code without being asked.
