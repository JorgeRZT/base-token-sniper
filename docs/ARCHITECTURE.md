# Architecture & Limitations

## Data flow

```
cron (every 60 s) -> scripts/monitor.js
   |-- eth_getLogs (Infura, Base) : V2 PairCreated, V3 PoolCreated, V4 Initialize   -> new pools
   |-- eth_getCode @ (poolBlock - N)                                                 -> "freshly deployed?"
   |-- DexScreener /token-pairs/v1/base/{token}                                      -> liquidity, price, volume
   |-- honeypot.is /v2/IsHoneypot                                                    -> sell simulation, taxes (V2/V3 only)
   |-- eth_getLogs on the token / pool / PositionManager                             -> holders, LP ownership, rug detection
   |-- lib/families.js : token family (address prefix / LP owner) -> hold time, expected multiple
   '-- Telegram Bot API (lib/message.js builds the text)                              -> alerts
state: data/state.json (also running peak/trough per watched token)   output: data/new-tokens.jsonl, data/outcomes.jsonl
```

## Design decisions

1. **Events, not contracts.** Uniswap V3 and V4 have no on-chain pool list and contracts cannot read past logs, so detection is off-chain. V2's `allPairs` array could be read by a contract, but one script covering V2/V3/V4 is simpler; the original reader contract was removed.
2. **Stateless runs.** Each run resumes from `state.json` (atomic write), guarded by a lock file against overlapping runs, and catches up after downtime (capped by `MAX_CATCHUP_BLOCKS`).
3. **Score-based filtering.** Only clear dangers are hard rejects; everything else subtracts points, because early tokens that later pump often have low liquidity, an owner or a hook. See FILTERS.md.
4. **Untrusted data.** Token names and symbols are attacker-controlled: they are escaped before being sent to Telegram, and token calls use low-level tolerant reads.
5. **No keys.** The bot only reads the chain; it needs no private key.

## Families

`lib/families.js` lists groups of tokens that launch and behave alike (today: addresses starting with `0xb2000000…` and pools whose LP is owned by `0xd54345…`). Each family carries hard-coded historical statistics (hold time = median minutes to the price peak, expected multiple, history). They come from the first ~19 h of data and are not validated forward; see [FINDINGS.md](FINDINGS.md). `lib/message.js` adds the family block to the Telegram alert and `monitor.js` stores the family id in each `new-tokens.jsonl` record. The same run also sends the **sell alert**: the watch entry of an alerted family token keeps `family`, the alert price (`p0`) and the last sampled price; when the token's age reaches the family's `holdMin` (and a price no older than 2.5 min exists, or 5 more minutes have passed) the monitor queues `buildSellMessage` once per token and appends the result to `data/sell-alerts.jsonl`.

## Limitations

- "Newest" means creation order, not trading activity. Pools may be empty.
- V4 has no honeypot simulation available; hooks are detected but their code is not analysed.
- Pools where neither side is WETH/USDC/native ETH (e.g. VIRTUAL pairs) are skipped.
- Filters are a snapshot at evaluation time; liquidity can be removed afterwards (the 1h/6h/24h follow-up measures how often).
- DexScreener numbers can be wrong or manipulated (a clone showed $30M liquidity).
- DexScreener, honeypot.is and Telegram are third-party services subject to rate limits. Infura quotas apply.
- Other Base DEXes (Aerodrome, BaseSwap...) are not covered.
- Only WETH, USDC and native ETH are treated as base assets.

## Ideas

- WebSocket subscription instead of 60 s polling (`wss://base-mainnet.infura.io/ws/v3/<key>`).
- Automatic buying (a separate component; would require a wallet and key management).
