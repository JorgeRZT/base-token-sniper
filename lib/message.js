// Telegram alert text (HTML parse mode).
const { esc } = require("./telegram");
const { classifyFamily } = require("./families");

const fmtX = (x) => `${x.toFixed(1).replace(/\.0$/, "")}×`;

/** Block shown after the header: the family, how long to hold and the multiple expected, or a note for isolated tokens. */
function familyBlock(r) {
  const f = classifyFamily(r);
  if (!f) return ["🏷 <b>No known family</b>: isolated token, no hold-time or multiple estimate."];
  const lines = [
    `🏷 <b>Family: ${esc(f.name)}</b> (${esc(f.describe)})`,
    `⏱ <b>Hold ~${f.holdMin} min</b> after this alert, then sell (the family's price peaks within ${f.holdRange} min)`,
    `📈 <b>Expected at that point: ~${fmtX(f.expectedPeak)}</b> (median peak) · cautious: ~${fmtX(f.expectedConservative)} (median price at 1h)`,
    `📊 History: ${esc(f.history)}`,
  ];
  const liq = r.dexscreener?.liquidityUsd;
  if (f.usualLiquidity && (liq == null || liq < f.usualLiquidity[0] || liq > f.usualLiquidity[1])) {
    lines.push(`⚠️ Off the family's usual pattern: ${liq == null ? "liquidity unknown" : `liquidity $${Math.round(liq).toLocaleString("en-US")}`}; ${esc(f.offTemplate)}`);
  }
  if (f.note) lines.push(`ℹ️ ${esc(f.note)}`);
  lines.push("<i>Historical figures, not a guarantee; measured from the price at alert time.</i>");
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

module.exports = { buildMessage };
