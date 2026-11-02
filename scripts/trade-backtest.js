// Usage: node scripts/trade-backtest.js [N] [holdMin] [family]
// Replays real trades on a local Base fork (anvil): for the latest N alerted tokens of a family it buys at the block of the
// alert, sells immediately, and also quotes what the position is worth `holdMin` minutes later (fork reset at that block).
// ONLY_TOKEN=0x... replays a single token (any family or none).
// Needs an RPC with archive state for the replayed blocks. No real funds are used (ephemeral wallet).
require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } = require("ethers");
const T = require("../lib/trader");
const { classifyFamily, FAMILIES } = require("../lib/families");

const PORT = 8597;
const N = Number(process.argv[2] || 10);
const FAM = process.argv[4] || "B2";
const fam = FAMILIES.find((f) => f.id === FAM);
const HOLD = Number(process.argv[3] || fam?.holdMin || 27);
const USD = Number(process.env.TRADE_USD || 0.1);
const rpc = process.env.BASE_RPC_URL || (process.env.INFURA_API_KEY && `https://base-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`);
const ANVIL = fs.existsSync(path.join(os.homedir(), ".foundry/bin/anvil")) ? path.join(os.homedir(), ".foundry/bin/anvil") : "anvil";
const up = new JsonRpcProvider(rpc, 8453, { staticNetwork: true });

(async () => {
  const anvil = spawn(ANVIL, ["--fork-url", rpc, "--port", String(PORT), "--chain-id", "8453", "--silent"], { stdio: "ignore" });
  const stop = () => { try { anvil.kill(); } catch {} };
  process.on("exit", stop);
  const p = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, 8453, { staticNetwork: true });
  for (let i = 0; ; i++) { try { await p.getBlockNumber(); break; } catch { if (i > 60) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 500)); } }
  const px = await T.ethUsd();
  const reset = (block) => p.send("anvil_reset", [{ forking: { jsonRpcUrl: rpc, blockNumber: block } }]);
  const wallet = new Wallet(Wallet.createRandom().privateKey, p);
  const fund = async () => { // 1 ETH, half of it wrapped so pools quoted in WETH can be traded too
    await p.send("anvil_setBalance", [wallet.address, "0x" + parseEther("1").toString(16)]);
    await (await new Contract("0x4200000000000000000000000000000000000006", ["function deposit() payable"], wallet).deposit({ value: parseEther("0.5") })).wait();
  };

  const recs = fs.readFileSync("data/new-tokens.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((r) => process.env.ONLY_TOKEN ? r.token.address.toLowerCase() === process.env.ONLY_TOKEN.toLowerCase() : r.alerted && r.uniswap === "v4" && classifyFamily(r)?.id === FAM && r.pool && Date.now() - new Date(r.detectedAt) > (HOLD + 5) * 60000).slice(-N);
  console.log(`Family ${FAM}, ${recs.length} alerted tokens, buy $${USD} at the alert block, sell at +${HOLD} min. ETH=$${px.toFixed(0)}`);
  const rows = [];
  for (const r of recs) {
    const sym = r.token.symbol, token = r.token.address;
    try {
      const ts0 = (await up.getBlock(r.block)).timestamp;
      const blockA = r.block + Math.max(0, Math.round((new Date(r.detectedAt) / 1000 - ts0) / 2));
      const blockB = blockA + HOLD * 30;
      await reset(blockA); await fund();
      const k = await T.poolKeyFromChain(p, r.pool, r.block);
      const amountIn = parseEther((USD / px).toFixed(18));
      const qb = await T.quote(p, k, token, true, amountIn);
      const buy = await T.swap(wallet, k, token, true, amountIn, (qb * 70n) / 100n);
      const bal = await new Contract(token, ["function balanceOf(address) view returns (uint256)"], p).balanceOf(wallet.address);
      let immediate = null;
      try { const qs0 = await T.quote(p, k, token, false, bal); immediate = Number(formatEther(qs0)) / Number(formatEther(amountIn)); } catch { immediate = "revert"; }
      await reset(blockB);
      let later = null;
      try { const qs = await T.quote(p, k, token, false, bal); later = Number(formatEther(qs)) / Number(formatEther(amountIn)); } catch { later = "revert"; }
      const f = (v) => (typeof v === "number" ? `${v.toFixed(2)}x` : v);
      console.log(`${r.detectedAt.slice(5, 16)} ${sym.padEnd(10)} hook ${(k.hooks || "").slice(0, 8)} fee ${String(k.fee).padEnd(5)} ts ${String(k.tickSpacing).padEnd(3)} | sell right away ${f(immediate).padStart(7)} | sell at +${HOLD}min ${f(later).padStart(7)}`);
      rows.push({ sym, immediate, later, hook: k.hooks, fee: k.fee });
    } catch (e) {
      console.log(`${r.detectedAt.slice(5, 16)} ${sym.padEnd(10)} FAIL ${String(e.shortMessage || e.message).slice(0, 110)}`);
      rows.push({ sym, fail: true });
    }
  }
  const ok = rows.filter((x) => !x.fail);
  const num = (v) => (typeof v === "number" ? v : 0);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  console.log(`\n${ok.length}/${rows.length} replayed. Total spent ${ok.length}x $${USD}. Value if sold right away: ${(sum(ok.map((x) => num(x.immediate))) / ok.length).toFixed(2)}x avg; if sold at +${HOLD} min: ${(sum(ok.map((x) => num(x.later))) / ok.length).toFixed(2)}x avg (reverts count as 0). Unsellable (<=5%) at +${HOLD}min: ${ok.filter((x) => num(x.later) <= 0.05).length}`);
  stop();
})().catch((e) => { console.error(e.message); process.exit(1); });
