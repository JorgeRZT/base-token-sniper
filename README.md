# Base Token Sniper

**Real-time detector and risk scorer for freshly launched tokens on Uniswap V2, V3 and V4 on Base, with Telegram alerts.**

[![License: MIT](https://img.shields.io/github/license/JorgeRZT/base-token-sniper?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![ethers.js](https://img.shields.io/badge/ethers-v6-2535a0?style=flat-square)](https://docs.ethers.org/v6/)
[![Chain: Base](https://img.shields.io/badge/chain-Base-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Uniswap V2 | V3 | V4](https://img.shields.io/badge/Uniswap-V2%20%7C%20V3%20%7C%20V4-FF007A?style=flat-square&logo=uniswap&logoColor=white)](https://uniswap.org)
[![Telegram alerts](https://img.shields.io/badge/alerts-Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Infura](https://img.shields.io/badge/RPC-Infura-FF6B35?style=flat-square)](https://infura.io)
[![Detection only](https://img.shields.io/badge/mode-detection%20only-lightgrey?style=flat-square)](#how-it-works)
[![Last commit](https://img.shields.io/github/last-commit/JorgeRZT/base-token-sniper?style=flat-square)](https://github.com/JorgeRZT/base-token-sniper/commits)
[![Issues](https://img.shields.io/github/issues/JorgeRZT/base-token-sniper?style=flat-square)](https://github.com/JorgeRZT/base-token-sniper/issues)
[![Stars](https://img.shields.io/github/stars/JorgeRZT/base-token-sniper?style=flat-square)](https://github.com/JorgeRZT/base-token-sniper/stargazers)

Detects **freshly deployed tokens on Uniswap V2, V3 and V4 on Base** (chainId 8453), scores their risk, and alerts you on Telegram. Runs as a stateless Node.js script that you schedule with cron every 60 seconds.

> **Detection only.** The bot never sends transactions and holds no private key. A new pool is not a vetted token: most are scams. Not financial advice.

## How it works

Each run of `scripts/monitor.js`:

1. Reads pool-creation events from the last processed block to the chain head, with one `eth_getLogs` call per chunk through Infura: `PairCreated` (V2 factory), `PoolCreated` (V3 factory) and `Initialize` (V4 PoolManager). For V4 the pool identifier is the `PoolId`.
2. Takes the non-base side of each pool (base = WETH, USDC, native ETH) and skips tokens already in the registry (`data/state.json`).
3. A token is **fresh** if it had no contract code `MAX_TOKEN_AGE_MIN` minutes (default 60) before its pool was created. Older tokens that just got a new pool are registered but not reported.
4. Fresh tokens wait up to `DEX_WAIT_MIN` minutes for DexScreener to index the pool (liquidity, price, volume), then go through the **risk filters** ([docs/FILTERS.md](docs/FILTERS.md)): impersonation, clones, liquidity, honeypot simulation, contract flags, holder concentration, LP ownership and rug-pull (liquidity removal) detection.
5. Every evaluated token is appended to `data/new-tokens.jsonl` with its score and reasons. Tokens that pass are sent to Telegram (failed deliveries are retried on the next run).
6. Follow-up: each evaluated token is checked again at **1h, 6h and 24h** (DexScreener liquidity/price) and appended to `data/outcomes.jsonl`. This is the data for tuning the filters.

Why on-chain events and not DexScreener as the source: DexScreener has no "new pools" endpoint and only lists pools after indexing them (a few minutes), so it is used only for enrichment.

## Requirements

- Node.js 18+
- An [Infura](https://infura.io) API key with the **Base mainnet** network enabled
- Optional: a Telegram bot

## Setup

```bash
git clone https://github.com/JorgeRZT/base-token-sniper.git
cd base-token-sniper
npm install
cp .env.example .env        # fill in INFURA_API_KEY (and the Telegram variables)
npm run monitor             # one test pass
```

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather); put its token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. For a channel: add the bot as **admin**. For a private chat: send the bot any message.
3. Run `npm run telegram:test` without `TELEGRAM_CHAT_ID`: it lists the chats the bot can see. Put the id (or `@channelname`) in `TELEGRAM_CHAT_ID`.
4. Run `npm run telegram:test` again: you should receive a test message.

Without Telegram configured the monitor still works and writes everything to `data/`.

## Running it every minute on macOS (cron)

```bash
cd /path/to/base-token-sniper && mkdir -p data
crontab -e
```

Add this single line (use the absolute path from `which node`):

```
* * * * * cd /path/to/base-token-sniper && /usr/local/bin/node scripts/monitor.js >> data/monitor.log 2>&1
```

macOS caveats:

- **Full Disk Access.** The project is under `~/Desktop`, which macOS protects. Grant Full Disk Access to `/usr/sbin/cron` (System Settings → Privacy & Security → Full Disk Access → `+` → press Cmd+Shift+G → `/usr/sbin/cron`), otherwise cron fails silently with "Operation not permitted". Alternatively move the project outside Desktop/Documents/Downloads.
- **Sleep.** Cron does not run while the Mac sleeps. Keep it awake with `caffeinate -s` in a terminal (or `sudo pmset -a sleep 0`). After a gap the monitor catches up (up to `MAX_CATCHUP_BLOCKS`, about 11 hours).
- **Check it works:** `tail -f data/monitor.log` should show one line per minute. `crontab -l` lists the job; `crontab -r` removes all jobs.

## Output files (`data/`, git-ignored)

| File | Content |
|---|---|
| `new-tokens.jsonl` | One JSON line per evaluated token: token, pool, creator, DexScreener data, score, reasons, holders, LP analysis, `alerted` |
| `outcomes.jsonl` | Follow-up at 1h / 6h / 24h: liquidity and price, with the score the token got |
| `state.json` | Registry, last block, pending queue, 48h launch history, Telegram retry queue |
| `monitor.log` | Cron output |

Delete `data/` to reset everything.

## Configuration (`.env`)

See `.env.example`. Main variables: `INFURA_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MIN_SCORE` (40), `MIN_LIQUIDITY_USD` (1000), `MAX_TAX_PCT` (25), `DEX_WAIT_MIN` (5), `MAX_TOKEN_AGE_MIN` (60), `LOCKER_ADDRESSES`, `BASE_RPC_URL`.

## Other tools

- `npm run latest:v3 -- 20 20000`: prints the latest V3 pools by scanning `PoolCreated` events (manual, standalone).

## Project layout

```
scripts/monitor.js           the bot (one pass, run by cron)
scripts/telegram-test.js     Telegram test / chat-id finder
scripts/latest-v3.js         manual V3 pool listing
lib/config.js                addresses, provider, helpers
lib/filters.js               scoring and rejection rules
lib/impersonation.js         known-token / brand impersonation
lib/holders.js               holder distribution from Transfer events
lib/lp.js                    LP ownership (burned / contract / wallet) for V2, V3, V4
lib/telegram.js              Telegram delivery
docs/                        ARCHITECTURE.md, FILTERS.md, STATE.md (project status)
```

Addresses on Base: V2 factory `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6`, V3 factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, V4 PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b`.

## License

MIT
