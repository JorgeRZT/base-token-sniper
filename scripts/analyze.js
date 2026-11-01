// Offline analysis of data/new-tokens.jsonl + data/outcomes.jsonl.
// Usage (from the project root): node scripts/analyze.js [--serial-min N] [--since ISO_DATE]
// Splits tokens into "serial" creators (>= N launches in the dataset, default 5) and the rest,
// then compares verdicts and 1h/6h/24h outcomes for each group and per version.
const fs = require("fs");

const arg = (name, d) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : d; };
const SERIAL_MIN = Number(arg("--serial-min", 5));
const SINCE = arg("--since", null);
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

let T = rd("data/new-tokens.jsonl");
if (SINCE) T = T.filter((t) => t.detectedAt >= SINCE);
const O = rd("data/outcomes.jsonl");
const out = {}; // token -> { hours: outcome }
for (const o of O) (out[o.token.toLowerCase()] ||= {})[o.checkpointHours] = o;
const oc = (t, h) => out[t.token.address.toLowerCase()]?.[h];

const cnt = (a, f) => a.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const passes = (t) => !t.verdict.reject && t.verdict.score >= 40;

const perCreator = cnt(T, (t) => t.creator);
const isSerial = (t) => perCreator[t.creator] >= SERIAL_MIN;

function report(name, set) {
  console.log(`\n===== ${name}: ${set.length} tokens, ${new Set(set.map((t) => t.creator)).size} creators`);
  if (!set.length) return;
  console.log("version:", cnt(set, (t) => t.uniswap));
  console.log("level:", cnt(set, (t) => t.verdict.level));
  console.log("score median/mean:", med(set.map((t) => t.verdict.score)), (set.reduce((a, t) => a + t.verdict.score, 0) / set.length).toFixed(1));
  console.log("passed (score>=40, no reject):", set.filter(passes).length, "| alerted:", set.filter((t) => t.alerted).length);
  console.log("LP owner kind:", cnt(set, (t) => t.verdict.lp?.topKind || "unknown"));
  console.log("reject reasons:", cnt(set.filter((t) => t.verdict.reject), (t) => t.verdict.reject.replace(/0x[0-9a-fA-F]+/g, "").replace(/\d+/g, "N").slice(0, 60)));
  console.log("median liquidity at detection:", med(set.map((t) => t.dexscreener?.liquidityUsd).filter((x) => x > 0)));
  for (const h of [1, 6, 24]) {
    const wo = set.filter((t) => oc(t, h));
    if (!wo.length) continue;
    const found = wo.filter((t) => oc(t, h).found);
    const withLiq = found.filter((t) => t.dexscreener?.liquidityUsd > 0);
    const collapsed = withLiq.filter((t) => oc(t, h).liquidityUsd < t.dexscreener.liquidityUsd * 0.2);
    const grew = withLiq.filter((t) => oc(t, h).liquidityUsd > t.dexscreener.liquidityUsd * 1.5);
    const ratios = found.filter((t) => +t.dexscreener?.priceUsd > 0 && +oc(t, h).priceUsd > 0).map((t) => +oc(t, h).priceUsd / +t.dexscreener.priceUsd);
    const vol = found.map((t) => oc(t, h).volume24h || 0);
    console.log(`  [${h}h] with outcome ${wo.length}, found ${found.length} | liquidity collapsed(<20%) ${collapsed.length}/${withLiq.length}, grew(>1.5x) ${grew.length}`
      + ` | price >=2x ${ratios.filter((x) => x >= 2).length}, >=5x ${ratios.filter((x) => x >= 5).length}, <0.5x ${ratios.filter((x) => x < 0.5).length} (of ${ratios.length})`
      + ` | vol24h>1000: ${vol.filter((v) => v > 1000).length}, <10: ${vol.filter((v) => v < 10).length}`);
    // Peak/trough since evaluation (only present on outcomes recorded after the peak tracking was added).
    const pk = found.filter((t) => oc(t, h).baselinePriceUsd > 0 && oc(t, h).peakPriceUsd > 0);
    if (pk.length) {
      const up = pk.map((t) => oc(t, h).peakPriceUsd / oc(t, h).baselinePriceUsd);
      const dn = pk.map((t) => oc(t, h).minPriceUsd / oc(t, h).baselinePriceUsd);
      const lq = found.filter((t) => oc(t, h).baselineLiquidityUsd > 0 && oc(t, h).minLiquidityUsd != null);
      console.log(`  [${h}h] with peak data ${pk.length}: peak/baseline >=2x ${up.filter((x) => x >= 2).length}, >=5x ${up.filter((x) => x >= 5).length}, median peak ${med(up).toFixed(2)}x`
        + ` | trough/baseline <0.5x ${dn.filter((x) => x < 0.5).length} | liquidity min <20% of baseline ${lq.filter((t) => oc(t, h).minLiquidityUsd < oc(t, h).baselineLiquidityUsd * 0.2).length}/${lq.length}`
        + ` | median minutes to peak ${med(pk.map((t) => oc(t, h).peakPriceAfterMin).filter((x) => x != null))}`);
    }
    // Collapse rate among tokens that passed the filter (the false-positive rate).
    const pw = withLiq.filter(passes);
    const pc = pw.filter((t) => oc(t, h).liquidityUsd < t.dexscreener.liquidityUsd * 0.2);
    console.log(`  [${h}h] passed-and-collapsed (false positives): ${pc.length}/${pw.length}`);
  }
}

if (!T.length) { console.log("No data."); process.exit(0); }
const hrs = (new Date(T[T.length - 1].detectedAt) - new Date(T[0].detectedAt)) / 36e5;
console.log(`Range ${T[0].detectedAt} -> ${T[T.length - 1].detectedAt} (${hrs.toFixed(1)} h), ${T.length} tokens (~${Math.round((T.length / hrs) * 24)}/day), serial threshold = ${SERIAL_MIN}`);
report("ALL", T);
report("SERIAL creators", T.filter(isSerial));
report("NON-SERIAL creators", T.filter((t) => !isSerial(t)));
for (const v of ["v2", "v3", "v4"]) report(`VERSION ${v}`, T.filter((t) => t.uniswap === v));

console.log("\n===== Serial creators (top)");
for (const [c, n] of Object.entries(perCreator).filter((e) => e[1] >= SERIAL_MIN).sort((a, b) => b[1] - a[1])) {
  const ts = T.filter((t) => t.creator === c);
  console.log(c.slice(0, 10), n, JSON.stringify(cnt(ts, (t) => t.uniswap)), "symbols:", [...new Set(ts.map((t) => t.token.symbol))].slice(0, 4).join("|"), "passed:", ts.filter(passes).length);
}
