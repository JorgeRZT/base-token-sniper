# Risk filters

The filters are deliberately **flexible**: early tokens that later pump often have low liquidity, an owner, or a hook, so most signals only subtract points instead of rejecting. Every token starts at 100 points; it is alerted if it is not hard-rejected and its score is at least `MIN_SCORE` (default 40). Every evaluated token, alerted or not, is stored in `data/new-tokens.jsonl` with its reasons, so you can tune the thresholds from real data.

## Hard rejects (never alerted)

| Condition | Source |
|---|---|
| Impersonates a well-known token (same symbol/name as cbBTC, USDC, WETH, DAI, AERO, VIRTUAL... with a different address) or uses a generic name such as ETH/BTC/USD/LUSD | `lib/impersonation.js` |
| All liquidity was removed after being added (rug pull) | `lib/lp.js` |
| Sell simulation says it is a honeypot | honeypot.is |
| Buy or sell tax above `MAX_TAX_PCT` (default 25%) | honeypot.is |
| Known liquidity below `MIN_LIQUIDITY_USD` (default $1,000) | DexScreener |

## Score penalties

| Signal | Points |
|---|---|
| Uses a brand name (anthropic, openai, spacex, tesla...) | -10 |
| Creator wallet launched 2-4 other tokens in the last 48h / 5 or more | -15 / -30 |
| Same symbol already launched in the last 48h (clone) | -15 |
| Liquidity unknown (not indexed after `DEX_WAIT_MIN`) | -10 |
| Liquidity under $5,000 | -10 |
| Tax between 10% and `MAX_TAX_PCT` | -20 |
| Sell simulation unavailable (always the case for V4) | -10 |
| Bytecode has `mint` / blacklist / `pause` / tax setter | -15 / -15 / -10 / -5 |
| Upgradeable proxy (EIP-1967) | -15 |
| `owner()` not renounced | -5 |
| V4 hook attached to the pool | -15 |
| One wallet (top holder or pool creator) holds 20-49% / 50% or more of the supply | -10 / -20 |
| Fewer than 5 holders | -5 |
| Holder distribution unavailable | -5 |
| 50%+ of the LP is in a regular wallet (can be pulled) | -20 |
| 50%+ of the LP is in a contract (may be a locker, verify) | -5 |
| LP split between several kinds of owner | -10 |
| LP ownership unreadable | -5 |

If 80% or more of the LP is burned or in an address from `LOCKER_ADDRESSES`, there is no penalty and the alert shows "✅ LP burned/locked".

## How the new checks work

- **LP ownership** (`lib/lp.js`): V2 rebuilds LP-token balances from the pair's `Transfer` events. V3 finds the position NFTs minted into the pool and resolves their owner in the NonfungiblePositionManager. V4 nets the `ModifyLiquidity` events per position and resolves the PositionManager NFT owner. Owners are classified as burned/locked (zero address, `0xdead`, or `LOCKER_ADDRESSES`), contract, or wallet.
- **Holders** (`lib/holders.js`): balances rebuilt from the token's `Transfer` events since just before its deployment (the pool and the V4 PoolManager are not counted as holders). Works on V2, V3 and V4.
- **Clones**: the creator is the sender of the pool-creation transaction. A 48h launch history is kept in `data/state.json`.

Levels: 🟢 ≥ 70, 🟡 ≥ `MIN_SCORE`, 🟠 below it (not alerted), 🔴 rejected.

## Measuring the filters

`data/outcomes.jsonl` records liquidity and price at 1h / 6h / 24h for every evaluated token together with the score it received, so the thresholds can be tuned against what really happened.

## Tuning

- More alerts, more risk: lower `MIN_SCORE` (e.g. 25) and `MIN_LIQUIDITY_USD`.
- Fewer, safer alerts: raise `MIN_SCORE` (e.g. 60) and require higher liquidity.

## What the filters do NOT catch

- **Locker contracts are not recognised automatically.** Add the addresses of lockers you trust (UNCX, Team Finance, PinkLock on Base...) to `LOCKER_ADDRESSES`, otherwise a locked LP shows as "held by a contract".
- **LP can still be pulled after the alert.** The LP check is a snapshot; a wallet-held LP can be removed at any time.
- **V4 tokens have no sell simulation.** honeypot.is does not support V4 pools, so a V4 honeypot can only be suspected from hooks and bytecode.
- Bytecode checks are string matches on function selectors. They produce false positives and can be evaded by obfuscated contracts.
- Impersonation only covers the list in `lib/impersonation.js`; a copy of a token not on that list is not caught (it may still be flagged as a clone).
- Social-engineering tokens, hook contents and contract-verification status are not analysed. A `low risk` label is not a safety guarantee.
- honeypot.is and DexScreener are third-party free APIs and may rate-limit or change. The token address is the only data sent to them.
