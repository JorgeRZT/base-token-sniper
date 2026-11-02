# Project state (read this first in a new session)

_Last updated: 2026-11-02 (15:30Z, ~27 h of data analysed, see FINDINGS section 10). **A major correction is at the top of `docs/FINDINGS.md`: the family "pumps" are unsellable honeypot pools.** Read `docs/FINDINGS.md` right after this file: it holds the data and conclusions of every analysis done so far._

## Goal
A "Base token sniper" **detection** bot: find freshly deployed tokens on Uniswap V2/V3/V4 on Base, score risk, alert on Telegram. Buying is out of scope until the user asks. The user wants flexible filters (accept some risk: many tokens pump within minutes or hours).

## What exists and works (tested against Base mainnet via the user's Infura key)
- `scripts/monitor.js`: one pass, run by cron every 60 s. Detects pools (V2/V3/V4), freshness check, DexScreener enrichment, risk scoring, Telegram alerts, 1h/6h/24h follow-up, peak/trough tracking and a price path (+2/+5/+10/+15/+30 min) for every evaluated token.
- Filters (docs/FILTERS.md): impersonation, clones, serial deployers (reject 5+ in 6 h), liquidity, honeypot.is, bytecode flags, proxy, owner, V4 hooks, holder concentration, LP ownership (V2/V3 with >= 50% in a wallet = reject; V4 only -5), liquidity removed = rug (reject).
- **Telegram switch**: `TELEGRAM_ENABLED=true|false` in `.env` (default true) turns the alerts on/off; while off nothing is queued.
- **Telegram works** (verified 2026-11-02 with `node scripts/alert-preview.js --send`). Alerts show the token's **family** (`lib/families.js`) or "isolated token"; B2 and D5 are marked `tradable: false` (warning instead of a hold time/multiple, no sell alerts). Each alert record in `new-tokens.jsonl` stores `family`.
- `scripts/analyze.js` (analysis of the jsonl), `scripts/alert-preview.js` (sample alerts), `scripts/telegram-test.js`.
- The earlier smart contract (`RecentPairsReader`) was **removed** from the project. It remains deployed on Base at `0x7aDE98D9aA5A797a9cE1198607d50b1471cb4d82`; harmless. The user's `.env` may still contain an unused `PRIVATE_KEY` that they were advised to delete.

## Repository
https://github.com/JorgeRZT/base-token-sniper (public, branch `main`, MIT). `.env` and `data/` are git-ignored; never commit secrets.

## Running now
Cron runs the monitor every minute since 2026-11-01 ~12:30Z (24 h run). **With Telegram enabled, every alerted token is now sent: ~450-600 buy alerts/day plus ~4-5 family sell alerts/hour**, of which only ~10 later peaked >= 2x. Digest/selection of alerts is still pending (see below).

## Auto-trading status
Requested by the user on 2026-11-02 (buy $0.10 with a dedicated wallet, only known families, sell automatically after the family hold time). **Paused**: the backtest showed that the pumping family pools cannot be sold. `lib/trader.js` (quote, buy, sell via the V4 Universal Router + Permit2, fee overrides) works on a local fork (`scripts/trade-fork-test.js`, `scripts/trade-backtest.js`) but is **not connected to the monitor** and no `TRADER_PRIVATE_KEY` variable was added to `.env.example`. Before reviving it: it needs a sellable strategy (the sell simulation now rejects unsellable V4 pools), policy code (`lib/autotrade.js`: limits, kill switch, positions in state.json, `data/trades.jsonl`) and a first live trade supervised by the user.

## Filter / code changes timeline (data before and after is not directly comparable)
- 2026-11-01 15:45Z: V2 with LP >= 50% in a wallet = reject; serial deployer (5+ other tokens from the same creator in 6 h) = reject; brand-name penalty -10 -> -30.
- 2026-11-01 ~17:41Z: peak/trough tracking in `outcomes.jsonl` (`baseline*`, `peak*`, `min*`). Clean peak data only for tokens evaluated after 17:45Z.
- 2026-11-02 ~07:15Z: V3 with LP >= 50% in a wallet = reject; V4 LP-in-wallet penalty -20 -> -5; price path (`path`) in outcomes.
- 2026-11-02 ~10:00Z: **V4 sell simulation** in `lib/filters.js` (hard reject when a small buy cannot be sold back for >= 50%; replaces the constant -10 when it works), V4 LP-in-wallet penalty back to -20, families marked `tradable: false`, family sell alerts disabled, `lib/trader.js` + fork scripts added.
- 2026-11-02 ~08:00Z: **family sell alert** (disabled at ~10:00Z) (`buildSellMessage`, `data/sell-alerts.jsonl`): when an alerted family token reaches the family's hold time the user gets a "SELL NOW" message with the result vs the alert price. Only tokens alerted after this change have it.
- 2026-11-02 ~07:30Z: family block in alerts (`lib/families.js`, `lib/message.js`), `family` field in `new-tokens.jsonl`, `TELEGRAM_CHAT_ID` accepted without `@`.

## Pending (not done)
1. **24 h analysis**: first pass done at ~27 h (FINDINGS section 10; only tokens detected 11-01 12:33-15:18Z have 24h data). Re-run `node scripts/analyze.js` once more 24 h checkpoints exist for post-10:00Z tokens (6h/24h of sell-simulated alerts), then recalibrate `lib/families.js`, re-check the V3 rule and the V4 penalty. **Next step proposed:** backtest (`scripts/trade-backtest.js`) the 12 isolated V4 tokens of 11-01 13:20-15:20Z with liquidity ~$9.1k and 60-77k volume/24h (2.4-2.8x at 24h) plus the 24h winners (P2P, GIGGLE, OFFR, ZEC), selling at +5/+15/+30/+60 min, to see if any sellable pattern exists.
2. ~~V4 sell simulation~~ **done** (2026-11-02 ~10:00Z). Watch how many V4 tokens are not simulable (-10 fallback) and re-run the analysis: all multiples before this date are DexScreener prices of pools that may not be sellable.
3. **Change how alerts are delivered**: hourly digest of the best candidates plus an immediate alert only for validated patterns (families), instead of ~450-600 alerts/day. Possible option: `TELEGRAM_ONLY_FAMILIES`.
4. **Policy for tokens without indexed liquidity** (48 of 288 alerts since 15:45Z had no price): leave them out of alerts or put them in a separate category.
5. **Log more token features** (deployer/factory contract, known launchpad LP owner) to test whether the B2 and D5 patterns predict pumps or were a coincidence of the first 19 h; also log the time of the last trade to measure token "life".
6. Re-evaluate what is worth alerting now that unsellable pools are rejected; re-run `scripts/trade-backtest.js` on other groups (isolated V4 tokens that pass the new filter, V2/V3) to find a sellable pattern with a real positive return before any buy logic. `data/sell-alerts.jsonl` holds the sell alerts sent between ~08:00Z and ~10:00Z (obsolete).
- Do not hard-code more rules for families before validating forward.
- Other ideas: flag implausible DexScreener liquidity (a clone showed $30M), recognise locker contracts (`LOCKER_ADDRESSES`), delayed alerts to filter early rugs, WebSocket instead of polling, V3 manual-listing tool cleanup.

## Observations about the platform
- honeypot.is does not support V4 pools; gas on Base is a fraction of a cent, so the chain choice depends on opportunity and bot competition (Base was kept).
- Infura public RPC rate limits `eth_getLogs`; the user's Infura key works for Base. DexScreener batch endpoint `tokens/v1/base/{a,b,...}` takes 30 addresses.
- Base V2 gets ~200-270 new pairs/day; across V2+V3+V4 ~1,700-2,100 tokens/day, ~93% V4.

## Conventions
- Everything (code, docs, comments, Telegram message text) in **English**; conversation with the user in Spanish.
- Never read or print the user's `.env` (it holds secrets, including the Telegram token). Do not add private keys or trading code without being asked.
