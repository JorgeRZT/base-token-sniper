// Telegram alert text (HTML parse mode).
const { esc } = require("./telegram");
const { classifyFamily } = require("./families");

const fmtX = (x) => `${x.toFixed(1).replace(/\.0$/, "")}×`;

/** Block shown after the header: the family, how long to hold and the multiple expected, or a note for isolated tokens. */
function familyBlock(r) {
  const f = classifyFamily(r);
  if (!f) return ["🏷 <b>No known family</b>: isolated token, no hold-time or multiple estimate."];
  if (f.tradable === false) {
    return [
      `🏷 <b>Family: ${f.name}</b> (${f.describe})`,
      `⚠️ <b>Not a buy signal</b>: ${f.warning}. The multiples shown on DexScreener for this family could not be cashed in.`,
    ];
  }
  const lines = [
    `🏷 <b>Family: ${f.name}</b> (${f.describe})`,
    `⏱ <b>Hold ~${f.holdMin} min</b> after this alert, then sell (the family's price peaks within ${f.holdRange} min)`,
    `📈 <b>Expected at that point: ~${fmtX(f.expectedPeak)}</b> (median peak) · cautious: ~${fmtX(f.expectedConservative)} (median price at 1h)`,
    `📊 History: ${f.history}`,
  ];
  const liq = r.dexscreener?.liquidityUsd;
  if (f.usualLiquidity && (liq == null || liq < f.usualLiquidity[0] || liq > f.usualLiquidity[1])) {
    lines.push(`⚠️ Off the family's usual pattern: ${liq == null ? "liquidity unknown" : `liquidity $${Math.round(liq).toLocaleString("en-US")}`}; ${f.offTemplate}`);
  }
  if (f.note) lines.push(`ℹ️ ${f.note}`);
  lines.push(`🔔 A <b>sell alert</b> will follow in ~${f.holdMin} min.`, "<i>Historical figures, not a guarantee; measured from the price at alert time.</i>");
  return lines;
}

function buildMessage(r) {
  const t = r.token, v = r.verdict, d = r.dexscreener;
  const lines = [
    `<b>${v.level}</b> · Uniswap ${r.uniswap.toUpperCase()} · score ${v.score}/100`,
    `<b>${esc(t.name)}</b> (${esc(t.symbol)})`,
    `<code>${t.address}</code>`,
    ...familyBlock(r),
  ];
  if (d) lines.push(`Liquidity: $${Math.round(d.liquidityUsd || 0).toLocaleString("en-US")} · Price: $${d.priceUsd ?? "?"} · Vol 24h: $${Math.round(d.volume24h || 0).toLocaleString("en-US")}`);
  else lines.push("Liquidity: not indexed by DexScreener yet");
  const hp = v.honeypot;
  if (hp) lines.push(`Sim: buy tax ${hp.buyTax}% / sell tax ${hp.sellTax}%`);
  if (v.holders) lines.push(`Holders: ${v.holders.holders} · top wallet ${v.holders.topHolderPct}% · creator ${v.holders.creatorPct}%`);
  if (v.lp) lines.push(`LP: ${v.lp.lockedPct}% burned/locked · ${v.lp.contractPct}% contract · ${v.lp.walletPct}% wallet`);
  for (const n of v.notes || []) lines.push(`✅ ${esc(n)}`);
  if (v.reasons.length) lines.push("", "<b>Warnings</b>", ...v.reasons.map((x) => `• ${esc(x)}`));
  const links = [
    `<a href="https://dexscreener.com/base/${d ? r.pool : t.address}">DexScreener</a>`,
    `<a href="https://basescan.org/token/${t.address}">Basescan</a>`,
    `<a href="https://honeypot.is/base?address=${t.address}">Honeypot.is</a>`,
  ];
  lines.push("", links.join(" · "));
  return lines.join("\n");
}

const money = (v) => (v == null ? "?" : `$${v < 0.01 ? Number(v).toPrecision(3) : Number(v).toFixed(v < 1 ? 5 : 2)}`);

/**
 * Sell alert for a family token: the hold time of its family has passed.
 * w = watch entry, fam = family, res = {ageMin, alertPriceUsd, priceUsd, multiple, peakMultiple, peakAfterMin, liquidityUsd}
 */
function buildSellMessage({ w, fam, res }) {
  const lines = [
    `💰 <b>SELL NOW · ${esc(fam.name)}</b>`,
    `<b>${esc(w.name)}</b> (${esc(w.symbol)})`,
    `<code>${w.token}</code>`,
    `⏱ ${res.ageMin} min since the buy alert (family hold time ~${fam.holdMin} min)`,
  ];
  if (res.multiple != null) {
    const pct = (res.multiple - 1) * 100;
    lines.push(
      `📈 <b>Result if bought at the alert and sold now: ${fmtX(res.multiple)} (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)</b>`,
      `Alert price ${money(res.alertPriceUsd)} → now ${money(res.priceUsd)}`,
    );
    if (res.peakMultiple != null) lines.push(`Peak so far: ${fmtX(res.peakMultiple)} at ${res.peakAfterMin} min · now at ${Math.round((res.multiple / res.peakMultiple) * 100)}% of the peak`);
    lines.push(`Family expectation: ~${fmtX(fam.expectedPeak)} at the peak (cautious ~${fmtX(fam.expectedConservative)})`);
    if (res.multiple < 1.05) lines.push("⚠️ This token did not follow the family pattern (flat or down): sell to limit the loss.");
    else if (res.multiple < fam.expectedConservative * 0.6) lines.push("⚠️ Well below the family's usual result.");
  } else {
    lines.push("📈 No fresh price from DexScreener: check the chart before selling.");
  }
  if (res.liquidityUsd != null) lines.push(`Pool liquidity: $${Math.round(res.liquidityUsd).toLocaleString("en-US")} (a large sell moves the price)`);
  lines.push(
    "<i>Price = last trade on DexScreener; the real sale depends on the pool's liquidity and on the token being sellable (V4 sells are not simulated).</i>",
    "",
    `<a href="https://dexscreener.com/base/${w.pool || w.token}">DexScreener</a> · <a href="https://basescan.org/token/${w.token}">Basescan</a>`,
  );
  return lines.join("\n");
}

module.exports = { buildMessage, buildSellMessage };
