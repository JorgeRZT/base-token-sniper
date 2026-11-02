// One monitoring pass. Designed to be run by cron every 60 seconds:
//   * * * * * cd /path/to/tokenSnipper && /path/to/node scripts/monitor.js >> data/monitor.log 2>&1
//
// Each run:
//   1. reads new pool-creation events (Uniswap V2 PairCreated, V3 PoolCreated, V4 Initialize)
//      from the last processed block up to the chain head (one eth_getLogs call per chunk);
//   2. extracts the non-base token of each pool and skips tokens already in the registry;
//   3. flags a token as "fresh" if its contract did not exist MAX_TOKEN_AGE_MIN minutes before the pool;
//   4. enriches it with token metadata and DexScreener data, prints it and appends it to data/new-tokens.jsonl.
// Detection only: this script never sends transactions.
const fs = require("fs");
const path = require("path");
const { Interface, id } = require("ethers");
const { ADDRESSES, getProvider, tokenInfo, pickNewToken } = require("../lib/config");
const { evaluate, cfg } = require("../lib/filters");
const { norm } = require("../lib/impersonation");
const { enabled: telegramEnabled, sendTelegram } = require("../lib/telegram");
const { classifyFamily, FAMILIES } = require("../lib/families");
const { buildMessage, buildSellMessage } = require("../lib/message");

const DATA = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA, "state.json");
const LOCK_FILE = path.join(DATA, "monitor.lock");
const OUT_FILE = path.join(DATA, "new-tokens.jsonl");
const OUTCOMES_FILE = path.join(DATA, "outcomes.jsonl");
const SELL_FILE = path.join(DATA, "sell-alerts.jsonl"); // every family sell alert with the result it reported (forward test of the family rule)
const SELL_PRICE_MAX_AGE_MS = 150e3; // a sell alert needs a price sampled in the last 2.5 min
const SELL_GIVE_UP_MIN = 5; // after holdMin + this, send the sell alert even without a fresh price
const CHECKPOINT_HOURS = [1, 6, 24]; // follow-up checks on every evaluated token
const MAX_CHECKS_PER_RUN = 40;
const PEAK_BATCH = 30; // DexScreener batch endpoint accepts up to 30 addresses
const PEAK_MAX_BATCHES_PER_RUN = 10; // peak/trough sampling budget per run (rotates through the watch list)
const PATH_MINUTES = [2, 5, 10, 15, 30]; // price path after the alert: price/liquidity at these ages (recorded at the first sample after each)
const PATH_MAX_LATE_MIN = 3; // a path point is only recorded if the sample is at most this many minutes late
const PEAK_WINDOW_HOURS = 24; // keep sampling price/liquidity for this long after evaluation

const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 60); // "just deployed" window
const FIRST_RUN_LOOKBACK = Number(process.env.FIRST_RUN_LOOKBACK || 150); // blocks (~5 min) on first run
const MAX_CATCHUP_BLOCKS = Number(process.env.MAX_CATCHUP_BLOCKS || 20000); // cap after long downtime
const DEX_WAIT_MIN = Number(process.env.DEX_WAIT_MIN || 5); // wait this long for DexScreener to index a new pool
const MAX_UNSENT = 50; // Telegram messages queued for retry
const CHUNK = 2000;
const BLOCK_TIME_S = 2;
const AGE_BLOCKS = Math.round((MAX_TOKEN_AGE_MIN * 60) / BLOCK_TIME_S);

const EVENTS = {
  v2: "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
  v3: "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  v4: "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
};
const iface = new Interface(Object.values(EVENTS));
const SOURCES = [
  { version: "v2", address: ADDRESSES.V2_FACTORY, topic: id("PairCreated(address,address,address,uint256)") },
  { version: "v3", address: ADDRESSES.V3_FACTORY, topic: id("PoolCreated(address,address,uint24,int24,address)") },
  { version: "v4", address: ADDRESSES.V4_POOL_MANAGER, topic: id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)") },
];

function acquireLock() {
  fs.mkdirSync(DATA, { recursive: true });
  try { // drop a stale lock left by a crashed run
    if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 5 * 60 * 1000) fs.unlinkSync(LOCK_FILE);
  } catch {}
  try { fs.closeSync(fs.openSync(LOCK_FILE, "wx")); return true; } catch { return false; }
}
const releaseLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };

function loadState() {
  try { return { pending: {}, unsent: [], launches: [], watch: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch { return { lastBlock: null, seen: {}, pending: {}, unsent: [], launches: [], watch: {} }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state));
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE); // atomic
}

function decode(log, version) {
  const e = iface.parseLog(log);
  if (version === "v2") return { token0: e.args.token0, token1: e.args.token1, pool: e.args.pair };
  if (version === "v3") return { token0: e.args.token0, token1: e.args.token1, pool: e.args.pool, fee: Number(e.args.fee) };
  return { token0: e.args.currency0, token1: e.args.currency1, pool: e.args.id, fee: Number(e.args.fee), hooks: e.args.hooks };
}

async function dexscreener(token) {
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${token}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const pairs = (await r.json()).filter((p) => p.dexId === "uniswap");
    if (!pairs.length) return null; // DexScreener usually indexes a pool within a few minutes
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return { liquidityUsd: best.liquidity?.usd ?? null, priceUsd: best.priceUsd ?? null, volume24h: best.volume?.h24 ?? null, url: best.url };
  } catch { return null; }
}

// Batch lookup (<= 30 tokens per call). Returns Map(lowercase token -> {liquidityUsd, priceUsd}) for the tokens DexScreener has indexed.
async function dexscreenerBatch(tokens) {
  const out = new Map();
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/base/${tokens.join(",")}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return out;
    for (const pr of (await r.json()).filter((x) => x.dexId === "uniswap" && x.baseToken?.address)) {
      const k = pr.baseToken.address.toLowerCase(), liq = pr.liquidity?.usd || 0;
      if (!out.has(k) || liq > out.get(k).liq) out.set(k, { liq, liquidityUsd: pr.liquidity?.usd ?? null, priceUsd: pr.priceUsd ?? null });
    }
  } catch {}
  return out;
}

// Fold one DexScreener sample into the token's running peak/trough (used to measure what could really have been captured).
function track(w, d) {
  w.lastSample = Date.now();
  if (!d) return;
  const price = Number(d.priceUsd), liq = Number(d.liquidityUsd);
  if (price > 0) { w.pLast = price; w.pLastAt = Date.now(); }
  if (price > 0) {
    if (!(w.p0 > 0)) w.p0 = price; // baseline = first price seen (the one at evaluation, or the first sample if it was not indexed yet)
    if (!(price <= (w.pMax || 0))) { w.pMax = price; w.pMaxAt = Date.now(); }
    if (!(price >= (w.pMin ?? Infinity))) w.pMin = price;
  }
  if (price > 0) {
    const ageMin = (Date.now() - w.t0) / 60000;
    w.path ||= {};
    for (const off of PATH_MINUTES) {
      if (w.path[off] === undefined && ageMin >= off && ageMin <= off + PATH_MAX_LATE_MIN) w.path[off] = [Math.round(ageMin * 10) / 10, price, liq > 0 ? liq : null]; // [actual age in min, price, liquidity]
    }
  }
  if (liq > 0) w.lLast = liq;
  if (liq > 0) {
    if (!(w.l0 > 0)) w.l0 = liq;
    if (!(liq <= (w.lMax || 0))) w.lMax = liq;
    if (!(liq >= (w.lMin ?? Infinity))) w.lMin = liq;
  }
}


async function main() {
  const provider = getProvider();
  const state = loadState();
  const head = await provider.getBlockNumber();
  let from = state.lastBlock === null ? head - FIRST_RUN_LOOKBACK : state.lastBlock + 1;
  if (head - from > MAX_CATCHUP_BLOCKS) {
    console.warn(`Gap of ${head - from} blocks exceeds MAX_CATCHUP_BLOCKS; skipping ahead.`);
    from = head - MAX_CATCHUP_BLOCKS;
  }
  if (from > head) return;

  // 1. collect creation events
  const byAddr = Object.fromEntries(SOURCES.map((s) => [s.address.toLowerCase(), s]));
  const pools = [];
  for (let start = from; start <= head; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, head);
    const logs = await provider.getLogs({
      address: SOURCES.map((s) => s.address),
      topics: [SOURCES.map((s) => s.topic)],
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const src = byAddr[log.address.toLowerCase()];
      pools.push({ version: src.version, block: log.blockNumber, tx: log.transactionHash, ...decode(log, src.version) });
    }
  }

  // 2. register new tokens; fresh ones go to the pending queue for evaluation
  for (const pool of pools) {
    const token = pickNewToken(pool.token0, pool.token1);
    if (!token) continue; // neither/both sides are base assets
    const key = token.toLowerCase();
    if (state.seen[key]) continue;

    const probeBlock = Math.max(pool.block - AGE_BLOCKS, 0);
    const codeBefore = await provider.getCode(token, probeBlock).catch(() => null);
    const fresh = codeBefore === "0x"; // no contract code before the window => deployed recently
    state.seen[key] = { block: pool.block, version: pool.version, fresh };
    if (!fresh) continue; // old token getting a new pool: registered but not reported

    state.pending[key] = {
      token, version: pool.version, block: pool.block, pool: pool.pool, fee: pool.fee ?? null,
      hooks: pool.hooks && pool.hooks !== ADDRESSES.NATIVE_ETH ? pool.hooks : null,
      tx: pool.tx, firstSeen: Date.now(), probeBlock,
      token0: pool.token0, token1: pool.token1,
      creator: (await provider.getTransaction(pool.tx).catch(() => null))?.from?.toLowerCase() ?? null, // wallet that created the pool
    };
  }

  // 3. evaluate pending tokens (waiting up to DEX_WAIT_MIN for DexScreener to index the pool)
  let reported = 0, rejected = 0;
  for (const [key, p] of Object.entries(state.pending)) {
    const dex = await dexscreener(p.token);
    const waited = (Date.now() - p.firstSeen) / 60000;
    if (!dex && waited < DEX_WAIT_MIN) continue; // try again next minute

    const info = await tokenInfo(provider, p.token);
    const verdict = await evaluate({
      provider, token: p.token, info, version: p.version, hooks: p.hooks, dex, pool: p.pool, poolBlock: p.block,
      fromBlock: p.probeBlock, creator: p.creator, token0: p.token0, token1: p.token1, fee: p.fee, history: state.launches,
    });
    delete state.pending[key];
    state.launches.push({ token: key, creator: p.creator, sym: norm(info.symbol), ts: Date.now() });
    state.watch[key] = { token: p.token, uniswap: p.version, score: verdict.score, level: verdict.level, reject: verdict.reject, t0: Date.now(), done: [] };
    track(state.watch[key], dex); // baseline price/liquidity at evaluation

    const record = {
      detectedAt: new Date().toISOString(), uniswap: p.version, block: p.block, token: info,
      pool: p.pool, fee: p.fee, hooks: p.hooks, tx: p.tx, dexscreener: dex,
      verdict: { level: verdict.level, score: verdict.score, reject: verdict.reject, reasons: verdict.reasons, notes: verdict.notes, honeypot: verdict.honeypot, contract: verdict.contract, holders: verdict.holders, lp: verdict.lp },
      creator: p.creator,
      alerted: verdict.passes,
      family: null,
    };
    record.family = classifyFamily(record)?.id ?? null; // known token family (see lib/families.js)
    Object.assign(state.watch[key], { alerted: verdict.passes, family: record.family, name: info.name, symbol: info.symbol, pool: p.pool }); // used by the family sell alert
    fs.appendFileSync(OUT_FILE, JSON.stringify(record) + "\n");
    console.log(`[${verdict.passes ? "ALERT" : "SKIP"} ${p.version.toUpperCase()}] ${info.name} (${info.symbol}) ${p.token} ${verdict.level} score=${verdict.score}` +
      (verdict.reject ? ` reject="${verdict.reject}"` : ""));
    if (!verdict.passes) { rejected++; continue; }
    reported++;
    if (telegramEnabled()) state.unsent.push(buildMessage(record)); // without Telegram, results only go to the jsonl (avoids a flood of stale alerts later)
  }

  const cutoff = Date.now() - 48 * 3600 * 1000;
  state.launches = state.launches.filter((l) => l.ts > cutoff); // keep 48h of launch history

  // 3a. peak/trough sampling: batch-query the tokens evaluated in the last PEAK_WINDOW_HOURS, least recently sampled first
  const sampling = Object.values(state.watch)
    .filter((w) => Date.now() - w.t0 < PEAK_WINDOW_HOURS * 3600e3)
    .sort((a, b) => {
      const ya = Date.now() - a.t0 < 35 * 60e3, yb = Date.now() - b.t0 < 35 * 60e3; // tokens still inside the price-path window go first
      return ya !== yb ? (ya ? -1 : 1) : (a.lastSample || 0) - (b.lastSample || 0);
    })
    .slice(0, PEAK_BATCH * PEAK_MAX_BATCHES_PER_RUN);
  for (let i = 0; i < sampling.length; i += PEAK_BATCH) {
    const chunk = sampling.slice(i, i + PEAK_BATCH);
    const res = await dexscreenerBatch(chunk.map((w) => w.token));
    for (const w of chunk) track(w, res.get(w.token.toLowerCase()) ?? null);
  }

  // 3a'. family sell alerts: once an alerted family token reaches the family's hold time, tell the user to sell and what the trade made
  for (const [key, w] of Object.entries(state.watch)) {
    if (!w.alerted || !w.family || w.sold) continue;
    const fam = FAMILIES.find((f) => f.id === w.family);
    if (!fam || fam.tradable === false) continue; // no sell alerts for families whose pools cannot be sold
    const ageMin = (Date.now() - w.t0) / 60000;
    if (ageMin < fam.holdMin) continue;
    const fresh = w.pLast > 0 && Date.now() - (w.pLastAt || 0) <= SELL_PRICE_MAX_AGE_MS;
    if (!fresh && ageMin < fam.holdMin + SELL_GIVE_UP_MIN) continue; // wait for a fresh price for a few minutes
    const res = {
      ts: new Date().toISOString(), token: w.token, symbol: w.symbol, family: fam.id, ageMin: Math.round(ageMin * 10) / 10,
      alertPriceUsd: w.p0 ?? null, priceUsd: fresh ? w.pLast : null, multiple: fresh && w.p0 > 0 ? w.pLast / w.p0 : null,
      peakMultiple: w.pMax > 0 && w.p0 > 0 ? w.pMax / w.p0 : null, peakAfterMin: w.pMaxAt ? Math.round((w.pMaxAt - w.t0) / 60000) : null,
      liquidityUsd: fresh ? (w.lLast ?? null) : null,
    };
    w.sold = true;
    fs.appendFileSync(SELL_FILE, JSON.stringify(res) + "\n");
    console.log(`[SELL ${fam.id}] ${w.symbol} ${w.token} after ${res.ageMin} min: ${res.multiple ? res.multiple.toFixed(2) + "x" : "no price"}`);
    if (telegramEnabled()) state.unsent.push(buildSellMessage({ w, fam, res }));
  }

  // 3b. follow-up: what happened to each evaluated token after 1h / 6h / 24h (data for tuning the filters)
  let checks = 0;
  for (const [key, w] of Object.entries(state.watch)) {
    for (const h of CHECKPOINT_HOURS) {
      if (w.done.includes(h) || Date.now() - w.t0 < h * 3600e3 || checks >= MAX_CHECKS_PER_RUN) continue;
      checks++;
      const d = await dexscreener(w.token);
      track(w, d);
      fs.appendFileSync(OUTCOMES_FILE, JSON.stringify({
        ts: new Date().toISOString(), token: w.token, uniswap: w.uniswap, score: w.score, level: w.level, reject: w.reject,
        checkpointHours: h, liquidityUsd: d?.liquidityUsd ?? null, priceUsd: d?.priceUsd ?? null, volume24h: d?.volume24h ?? null, found: Boolean(d),
        // running extremes since evaluation (sampled about every 1-3 min); baseline = first price/liquidity seen
        baselinePriceUsd: w.p0 ?? null, baselineLiquidityUsd: w.l0 ?? null,
        peakPriceUsd: w.pMax ?? null, peakPriceAfterMin: w.pMaxAt ? Math.round((w.pMaxAt - w.t0) / 60000) : null, minPriceUsd: w.pMin ?? null,
        peakLiquidityUsd: w.lMax ?? null, minLiquidityUsd: w.lMin ?? null,
        path: w.path ?? null, // {minutes after evaluation: [actual age, price, liquidity]}
      }) + "\n");
      w.done.push(h);
    }
    if (w.done.includes(Math.max(...CHECKPOINT_HOURS)) || Date.now() - w.t0 > 48 * 3600e3) delete state.watch[key];
  }

  // 4. deliver Telegram alerts (failed ones stay queued and are retried on the next run)
  if (!telegramEnabled()) state.unsent = []; // switched off (TELEGRAM_ENABLED=false) or not configured: nothing stale is sent later
  if (state.unsent.length) {
    if (telegramEnabled()) {
      const remaining = [];
      for (const msg of state.unsent) {
        if (remaining.length || !(await sendTelegram(msg))) remaining.push(msg);
        else await new Promise((r) => setTimeout(r, 1100)); // Telegram: ~1 msg/s per chat
      }
      const sent = state.unsent.length - remaining.length;
      state.unsent = remaining.slice(-MAX_UNSENT);
      console.log(`Telegram: sent ${sent}, queued for retry ${state.unsent.length}`);
    }
  }
  const found = reported;

  state.lastBlock = head;
  saveState(state);
  console.log(`${new Date().toISOString()} blocks ${from}-${head}: ${pools.length} pools, ${found} alerts, ${rejected} filtered out, ${Object.keys(state.pending).length} pending, ${Object.keys(state.seen).length} tokens registered`);
}

if (!acquireLock()) { console.log("Previous run still active; skipping."); process.exit(0); }
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(releaseLock);
