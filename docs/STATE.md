# Project state (read this first in a new session)

_Last updated: 2026-11-01._

## Goal
A "Base token sniper" **detection** bot: find freshly deployed tokens on Uniswap V2/V3/V4 on Base, score risk, alert on Telegram. Buying is out of scope for now. The user wants flexible filters (accept some risk: many tokens pump within hours or days).

## What exists and works (tested against Base mainnet via the user's Infura key)
- `scripts/monitor.js`: one pass, designed for cron every 60 s. Detects pools (V2/V3/V4), freshness check, DexScreener enrichment, risk scoring, Telegram alerts, 1h/6h/24h follow-up.
- Filters (docs/FILTERS.md): impersonation, clones (creator/symbol, 48h), liquidity, honeypot.is, bytecode flags, proxy, owner, V4 hooks, holder concentration, LP ownership (burned/contract/wallet), liquidity-removed = rug pull (hard reject).
- The earlier smart contract (`RecentPairsReader`) was **removed** from the project (the bot does not need it). It remains deployed on Base at `0x7aDE98D9aA5A797a9cE1198607d50b1471cb4d82`; harmless. The user's `.env` may still contain an unused `PRIVATE_KEY` that they were advised to delete.

## Not done / pending
- **Telegram is not configured yet** (the user will set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`); sending to Telegram has never been tested end to end.
- The user is about to run the bot ~24 hours via cron and will share `data/new-tokens.jsonl` (and `data/outcomes.jsonl`) for review.

## Next steps (after the 24 h run)
1. Analyse the jsonl: how many tokens evaluated/passed per day (the estimate was ~300-450 passing per day at `MIN_SCORE=40`, from a single 30-min sample), the score distribution, the false-positive rate (passed but rugged: compare `outcomes.jsonl` at 1h/6h/24h) and tokens that pumped.
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
