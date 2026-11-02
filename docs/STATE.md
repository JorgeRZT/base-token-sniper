# Project state (read this first in a new session)

_Last updated: 2026-11-02 (morning). Read `docs/FINDINGS.md` right after this file: it holds the data and conclusions of every analysis done so far._

## Goal
A "Base token sniper" **detection** bot: find freshly deployed tokens on Uniswap V2/V3/V4 on Base, score risk, alert on Telegram. Buying is out of scope until the user asks. The user wants flexible filters (accept some risk: many tokens pump within minutes or hours).

## What exists and works (tested against Base mainnet via the user's Infura key)
- `scripts/monitor.js`: one pass, run by cron every 60 s. Detects pools (V2/V3/V4), freshness check, DexScreener enrichment, risk scoring, Telegram alerts, 1h/6h/24h follow-up, peak/trough tracking and a price path (+2/+5/+10/+15/+30 min) for every evaluated token.
- Filters (docs/FILTERS.md): impersonation, clones, serial deployers (reject 5+ in 6 h), liquidity, honeypot.is, bytecode flags, proxy, owner, V4 hooks, holder concentration, LP ownership (V2/V3 with >= 50% in a wallet = reject; V4 only -5), liquidity removed = rug (reject).
- **Telegram works** (verified 2026-11-02 with `node scripts/alert-preview.js --send`). Alerts now show the token's **family** (`lib/families.js`): hold time and expected multiple, or "isolated token". Each alert record in `new-tokens.jsonl` stores `family`.
- `scripts/analyze.js` (analysis of the jsonl), `scripts/alert-preview.js` (sample alerts), `scripts/telegram-test.js`.
- The earlier smart contract (`RecentPairsReader`) was **removed** from the project. It remains deployed on Base at `0x7aDE98D9aA5A797a9cE1198607d50b1471cb4d82`; harmless. The user's `.env` may still contain an unused `PRIVATE_KEY` that they were advised to delete.

## Repository
https://github.com/JorgeRZT/base-token-sniper (public, branch `main`, MIT). `.env` and `data/` are git-ignored; never commit secrets.

## Running now
Cron runs the monitor every minute since 2026-11-01 ~12:30Z (24 h run). **With Telegram enabled, every alerted token is now sent: ~450-600 alerts/day**, of which only ~10 later peaked >= 2x. Digest/selection of alerts is still pending (see below).

## Filter / code changes timeline (data before and after is not directly comparable)
- 2026-11-01 15:45Z: V2 with LP >= 50% in a wallet = reject; serial deployer (5+ other tokens from the same creator in 6 h) = reject; brand-name penalty -10 -> -30.
- 2026-11-01 ~17:41Z: peak/trough tracking in `outcomes.jsonl` (`baseline*`, `peak*`, `min*`). Clean peak data only for tokens evaluated after 17:45Z.
- 2026-11-02 ~07:15Z: V3 with LP >= 50% in a wallet = reject; V4 LP-in-wallet penalty -20 -> -5; price path (`path`) in outcomes.
- 2026-11-02 ~07:30Z: family block in alerts (`lib/families.js`, `lib/message.js`), `family` field in `new-tokens.jsonl`, `TELEGRAM_CHAT_ID` accepted without `@`.

## Pending (not done)
1. **24 h analysis** (checkpoints start arriving ~12:30Z on 2026-11-02): run `node scripts/analyze.js`, update `docs/FINDINGS.md`, recalibrate `lib/families.js`, re-check the V3 rule and the V4 penalty.
2. **V4 sell simulation**: quote a minimal sell through the V4 Quoter (a revert = hook blocks selling or no usable liquidity) and replace the constant -10 "sell simulation not available for V4" (it is the same for every V4 token and inflates V2/V3 relative to V4). Prerequisite for any buy logic.
3. **Change how alerts are delivered**: hourly digest of the best candidates plus an immediate alert only for validated patterns (families), instead of ~450-600 alerts/day. Possible option: `TELEGRAM_ONLY_FAMILIES`.
4. **Policy for tokens without indexed liquidity** (48 of 288 alerts since 15:45Z had no price): leave them out of alerts or put them in a separate category.
5. **Log more token features** (deployer/factory contract, known launchpad LP owner) to test whether the B2 and D5 patterns predict pumps or were a coincidence of the first 19 h; also log the time of the last trade to measure token "life".
6. **Forward paper-trading test** of the family rule (price at +N min after each alert) before any buy logic.
- Do not hard-code more rules for families before validating forward.
- Other ideas: flag implausible DexScreener liquidity (a clone showed $30M), recognise locker contracts (`LOCKER_ADDRESSES`), delayed alerts to filter early rugs, WebSocket instead of polling, V3 manual-listing tool cleanup.

## Observations about the platform
- honeypot.is does not support V4 pools; gas on Base is a fraction of a cent, so the chain choice depends on opportunity and bot competition (Base was kept).
- Infura public RPC rate limits `eth_getLogs`; the user's Infura key works for Base. DexScreener batch endpoint `tokens/v1/base/{a,b,...}` takes 30 addresses.
- Base V2 gets ~200-270 new pairs/day; across V2+V3+V4 ~1,700-2,100 tokens/day, ~93% V4.

## Conventions
- Everything (code, docs, comments, Telegram message text) in **English**; conversation with the user in Spanish.
- Never read or print the user's `.env` (it holds secrets, including the Telegram token). Do not add private keys or trading code without being asked.
