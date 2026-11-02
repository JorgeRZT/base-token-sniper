// Usage: node scripts/alert-preview.js [--send]
// Shows how an alert looks for an isolated token and for a token of a known family, using real records from
// data/new-tokens.jsonl. With --send, both are sent to Telegram (prefixed with a TEST marker).
require("dotenv").config();
const fs = require("fs");
const { buildMessage, buildSellMessage } = require("../lib/message");
const { classifyFamily, FAMILIES } = require("../lib/families");
const { sendTelegram, enabled } = require("../lib/telegram");

const recs = fs.readFileSync("data/new-tokens.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const alerted = recs.filter((r) => r.alerted);
const solo = alerted.filter((r) => !classifyFamily(r) && r.dexscreener && r.uniswap === "v4").sort((a, b) => b.verdict.score - a.verdict.score)[0]; // best-scoring isolated V4 token with DexScreener data
const fam = alerted.filter((r) => classifyFamily(r)?.id === "B2" && r.dexscreener?.liquidityUsd >= 2000 && r.dexscreener.liquidityUsd <= 2600).slice(-1)[0]; // latest typical B2 token
if (!solo || !fam) throw new Error("Need at least one alerted isolated token and one alerted B2 token in data/new-tokens.jsonl");

(async () => {
  // Sell alert sample: a real past B2 token, using its price at the 1h checkpoint as the "sell" price (simulated).
  const outs = fs.existsSync("data/outcomes.jsonl") ? fs.readFileSync("data/outcomes.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const sellRec = FAMILIES.find((x) => x.id === "B2")?.tradable === false ? null : alerted.filter((r) => classifyFamily(r)?.id === "B2" && r.token.symbol && r.token.symbol !== "?" && outs.some((o) => o.token.toLowerCase() === r.token.address.toLowerCase() && o.checkpointHours === 1 && o.peakPriceUsd > 0 && o.baselinePriceUsd > 0 && +o.priceUsd > o.baselinePriceUsd * 3)).slice(-1)[0];
  const sellOut = sellRec && outs.find((o) => o.token.toLowerCase() === sellRec.token.address.toLowerCase() && o.checkpointHours === 1);
  const sellMsg = sellRec && (() => {
    const f = FAMILIES.find((x) => x.id === "B2");
    if (f.tradable === false) return null; // no sell alerts for families whose pools cannot be sold
    const res = { ageMin: f.holdMin, alertPriceUsd: sellOut.baselinePriceUsd, priceUsd: +sellOut.priceUsd, multiple: +sellOut.priceUsd / sellOut.baselinePriceUsd, peakMultiple: sellOut.peakPriceUsd / sellOut.baselinePriceUsd, peakAfterMin: sellOut.peakPriceAfterMin, liquidityUsd: sellOut.liquidityUsd };
    return buildSellMessage({ w: { token: sellRec.token.address, name: sellRec.token.name, symbol: sellRec.token.symbol, pool: sellRec.pool }, fam: f, res });
  })();
  for (const [label, rec, text] of [["ISOLATED TOKEN", solo, null], ["FAMILY TOKEN", fam, null], ["FAMILY SELL ALERT (simulated with the 1h price of a real past token)", sellRec, sellMsg]]) {
    if (!rec) continue;
    const msg = `🧪 <b>TEST · ${label}</b> (real past record)\n\n${text || buildMessage(rec)}`;
    console.log(`\n--- ${label}: ${rec.token.symbol} ${rec.token.address}\n${msg.replace(/<[^>]+>/g, "")}`);
    if (process.argv.includes("--send")) {
      if (!enabled()) { console.log("Telegram is not configured."); continue; }
      console.log((await sendTelegram(msg)) ? "-> sent" : "-> FAILED to send");
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
})();
