// Usage: node scripts/trade-fork-test.js [N]
// Forks Base locally with anvil (Foundry) and runs a full buy -> sell round trip with an ephemeral funded wallet on the
// latest N alerted family tokens, using lib/trader.js. No real funds and no .env key are involved (only the RPC URL).
require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } = require("ethers");
const T = require("../lib/trader");
const { classifyFamily } = require("../lib/families");

const PORT = 8599;
const N = Number(process.argv[2] || 4);
const USD = Number(process.env.TRADE_USD || 0.1);
const rpc = process.env.BASE_RPC_URL || (process.env.INFURA_API_KEY && `https://base-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`);
if (!rpc) throw new Error("Missing INFURA_API_KEY / BASE_RPC_URL");
const ANVIL = fs.existsSync(path.join(os.homedir(), ".foundry/bin/anvil")) ? path.join(os.homedir(), ".foundry/bin/anvil") : "anvil";

(async () => {
  const anvil = spawn(ANVIL, ["--fork-url", rpc, "--port", String(PORT), "--chain-id", "8453", "--silent"], { stdio: "ignore" });
  const stop = () => { try { anvil.kill(); } catch {} };
  process.on("exit", stop);
  const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, 8453, { staticNetwork: true });
  for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break; } catch { if (i > 60) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 500)); } }
  const wallet = new Wallet(Wallet.createRandom().privateKey, provider);
  await provider.send("anvil_setBalance", [wallet.address, "0x" + parseEther("1").toString(16)]);
  const px = await T.ethUsd();
  console.log(`Fork ready. Ephemeral wallet ${wallet.address} with 1 ETH. ETH = $${px.toFixed(0)}. Trade size $${USD}.`);

  const recs = fs.readFileSync("data/new-tokens.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((r) => r.alerted && r.uniswap === "v4" && classifyFamily(r) && r.pool).slice(-N);
  let ok = 0;
  for (const r of recs) {
    const sym = r.token.symbol, token = r.token.address;
    try {
      const k = await T.poolKeyFromChain(provider, r.pool, r.block);
      T.assertPoolId(k, r.pool);
      const amountIn = parseEther((USD / px).toFixed(18));
      const d = T.direction(k, token, true);
      const quoteBuy = await T.quote(provider, k, token, true, amountIn);
      const buy = await T.swap(wallet, k, token, true, amountIn, (quoteBuy * 80n) / 100n);
      const erc = new Contract(token, ["function balanceOf(address) view returns (uint256)"], provider);
      const bal = await erc.balanceOf(wallet.address);
      const quoteSell = await T.quote(provider, k, token, false, bal);
      const sell = await T.swap(wallet, k, token, false, bal, (quoteSell * 90n) / 100n);
      const spent = Number(formatEther(amountIn)) * px, got = Number(formatEther(sell.amountOut)) * px;
      const gas = Number(formatEther(buy.costWei + sell.costWei)) * px;
      console.log(`OK  ${sym.padEnd(10)} hook ${(k.hooks || "").slice(0, 8)} fee ${k.fee} quote ${d.quote === "0x0000000000000000000000000000000000000000" ? "ETH" : "other"} | in $${spent.toFixed(4)} -> out $${got.toFixed(4)} (round trip ${((got / spent - 1) * 100).toFixed(1)}%) | gas buy+approve+sell $${gas.toFixed(4)} (${((gas / spent) * 100).toFixed(0)}% of the trade)`);
      ok++;
    } catch (e) {
      console.log(`FAIL ${sym.padEnd(10)} ${String(e.shortMessage || e.message).slice(0, 160)}`);
    }
  }
  console.log(`${ok}/${recs.length} round trips OK`);
  stop();
})().catch((e) => { console.error(e.message); process.exit(1); });
