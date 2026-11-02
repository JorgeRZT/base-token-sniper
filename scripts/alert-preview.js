// Usage: node scripts/alert-preview.js [--send]
// Shows how an alert looks for an isolated token and for a token of a known family, using real records from
// data/new-tokens.jsonl. With --send, both are sent to Telegram (prefixed with a TEST marker).
require("dotenv").config();
const fs = require("fs");
const { buildMessage } = require("../lib/message");
const { classifyFamily } = require("../lib/families");
const { sendTelegram, enabled } = require("../lib/telegram");

const recs = fs.readFileSync("data/new-tokens.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const alerted = recs.filter((r) => r.alerted);
const solo = alerted.filter((r) => !classifyFamily(r) && r.dexscreener && r.uniswap === "v4").sort((a, b) => b.verdict.score - a.verdict.score)[0]; // best-scoring isolated V4 token with DexScreener data
const fam = alerted.filter((r) => classifyFamily(r)?.id === "B2" && r.dexscreener?.liquidityUsd >= 2000 && r.dexscreener.liquidityUsd <= 2600).slice(-1)[0]; // latest typical B2 token
if (!solo || !fam) throw new Error("Need at least one alerted isolated token and one alerted B2 token in data/new-tokens.jsonl");

(async () => {
  for (const [label, rec] of [["ISOLATED TOKEN", solo], ["FAMILY TOKEN", fam]]) {
    const msg = `🧪 <b>TEST · ${label}</b> (real past record)\n\n${buildMessage(rec)}`;
    console.log(`\n--- ${label}: ${rec.token.symbol} ${rec.token.address}\n${msg.replace(/<[^>]+>/g, "")}`);
    if (process.argv.includes("--send")) {
      if (!enabled()) { console.log("Telegram is not configured."); continue; }
      console.log((await sendTelegram(msg)) ? "-> sent" : "-> FAILED to send");
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
})();
