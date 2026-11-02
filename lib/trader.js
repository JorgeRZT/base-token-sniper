// On-chain mechanics for the automatic trader: quote, buy and sell a token in a Uniswap V4 pool through the
// Universal Router. Policy (what to buy, when to sell, limits) lives in lib/autotrade.js.
//
// Never log the private key. The wallet is built from TRADER_PRIVATE_KEY (see .env.example).
const { Contract, Wallet, AbiCoder, ZeroAddress, parseEther, formatEther, id, getAddress } = require("ethers");
const { ADDRESSES } = require("./config");

const A = {
  UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43", // Base; its poolManager() is the V4 PoolManager (verified on-chain)
  V4_QUOTER: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D", // Base; poolManager() verified on-chain
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};
const CHAIN_ID = 8453;
const coder = AbiCoder.defaultAbiCoder();

// Universal Router commands and V4 router actions
const CMD = { PERMIT2_PERMIT: 0x0a, V4_SWAP: 0x10 };
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f };

const POOL_KEY = "tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const UR_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
const QUOTER_ABI = [`function quoteExactInputSingle(tuple(${POOL_KEY} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"];
const PERMIT2_ABI = ["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"];
const WETH_ABI = ["function withdraw(uint256 wad)", "function deposit() payable", "function balanceOf(address) view returns (uint256)"];
const INIT_IFACE = "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)";

const lc = (a) => String(a).toLowerCase();

/** Builds the wallet from TRADER_PRIVATE_KEY, or returns null. */
function loadWallet(provider) {
  const pk = (process.env.TRADER_PRIVATE_KEY || "").trim();
  if (!pk) return null;
  return new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
}

/** Native ETH price in USD (DexScreener, deepest WETH pair). */
async function ethUsd() {
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${ADDRESSES.WETH}`, { signal: AbortSignal.timeout(8000) });
  const best = (await r.json())
    .filter((p) => p.baseToken?.address?.toLowerCase() === ADDRESSES.WETH.toLowerCase() && p.liquidity?.usd > 0 && Number(p.priceUsd) > 0)
    .sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
  const price = Number(best?.priceUsd);
  if (!(price > 100)) throw new Error("ETH price unavailable");
  return price;
}

/** Reads the PoolKey of a V4 pool from its Initialize event (the id is the pool id; block narrows the search). */
async function poolKeyFromChain(provider, poolId, block) {
  const { Interface } = require("ethers");
  const iface = new Interface([INIT_IFACE]);
  const logs = await provider.getLogs({ address: ADDRESSES.V4_POOL_MANAGER, topics: [id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"), poolId], fromBlock: Math.max(0, block - 5), toBlock: block + 5 });
  if (!logs.length) throw new Error("Initialize event not found for pool");
  const e = iface.parseLog(logs[0]).args;
  return { currency0: e.currency0, currency1: e.currency1, fee: Number(e.fee), tickSpacing: Number(e.tickSpacing), hooks: e.hooks };
}

const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];

/** The pool must really hash to the pool id we saw, otherwise we would trade in another pool. */
function assertPoolId(k, poolId) {
  const h = require("ethers").keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], keyTuple(k)));
  if (lc(h) !== lc(poolId)) throw new Error("pool key does not match pool id");
}

/** Side of the swap: input/output currencies and direction for buying (quote -> token) or selling (token -> quote). */
function direction(k, token, buying) {
  const tokenIs0 = lc(k.currency0) === lc(token);
  if (!tokenIs0 && lc(k.currency1) !== lc(token)) throw new Error("token not in pool");
  const quote = tokenIs0 ? k.currency1 : k.currency0;
  const zeroForOne = buying ? !tokenIs0 : tokenIs0; // buying the token: spend the quote currency
  return { quote, zeroForOne, currencyIn: buying ? quote : token, currencyOut: buying ? token : quote };
}

/** Quoter (simulates the swap including the pool's hook). Returns the amount out, or throws if the swap would revert. */
async function quote(provider, k, token, buying, amountIn) {
  const d = direction(k, token, buying);
  const q = new Contract(A.V4_QUOTER, QUOTER_ABI, provider);
  const [out] = await q.quoteExactInputSingle.staticCall({ poolKey: keyTuple(k), zeroForOne: d.zeroForOne, exactAmount: amountIn, hookData: "0x" });
  return out;
}

function v4SwapInput(k, d, amountIn, minOut) {
  const actions = Uint8Array.from([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL]);
  const params = [
    coder.encode([`tuple(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`], [[keyTuple(k), d.zeroForOne, amountIn, minOut, "0x"]]),
    coder.encode(["address", "uint256"], [d.currencyIn, amountIn]),
    coder.encode(["address", "uint256"], [d.currencyOut, minOut]),
  ];
  return coder.encode(["bytes", "bytes[]"], [actions, params]);
}

/** PERMIT2_PERMIT input: lets the router pull `amount` of `token` from the wallet (single-use, signed off-chain). */
async function permitInput(wallet, token, amount) {
  const p2 = new Contract(A.PERMIT2, PERMIT2_ABI, wallet.provider);
  const { nonce } = await p2.allowance(wallet.address, token, A.UNIVERSAL_ROUTER);
  const expiration = Math.floor(Date.now() / 1000) + 600;
  const details = { token, amount, expiration, nonce };
  const sigDeadline = BigInt(expiration);
  const sig = await wallet.signTypedData(
    { name: "Permit2", chainId: CHAIN_ID, verifyingContract: A.PERMIT2 },
    { PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
      PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
    { details, spender: A.UNIVERSAL_ROUTER, sigDeadline });
  return coder.encode(
    ["tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline)", "bytes"],
    [[[token, amount, expiration, nonce], A.UNIVERSAL_ROUTER, sigDeadline], sig]);
}

/** Base fees are ~0.005 gwei; ethers would add a 1 gwei tip by default (200x the real cost), so set the fees explicitly. */
async function feeOverrides(provider) {
  const base = (await provider.getBlock("latest")).baseFeePerGas ?? 10_000_000n;
  const tip = 1_000_000n; // 0.001 gwei
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 3n + tip };
}

/** Real cost of a mined tx in ETH: L2 execution + the L1 data fee that Base adds (not part of gasUsed * price). */
async function txCostEth(provider, hash) {
  const r = await provider.send("eth_getTransactionReceipt", [hash]);
  const l2 = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
  const l1 = r.l1Fee ? BigInt(r.l1Fee) : 0n;
  return { wei: l2 + l1, status: r.status === "0x1" };
}

/**
 * Sends the swap. For selling a token it first makes sure Permit2 may pull it (approve once, max) and attaches a signed permit.
 * @returns {{hash, amountOut (bigint), costWei (bigint)}}
 */
async function swap(wallet, k, token, buying, amountIn, minOut) {
  const provider = wallet.provider;
  const d = direction(k, token, buying);
  const ur = new Contract(A.UNIVERSAL_ROUTER, UR_ABI, wallet);
  const commands = [];
  const inputs = [];
  let value = 0n;
  let costWei = 0n;
  const native = lc(d.currencyIn) === ZeroAddress;
  if (native) value = amountIn;
  else {
    const erc = new Contract(d.currencyIn, ERC20_ABI, wallet);
    if ((await erc.allowance(wallet.address, A.PERMIT2)) < amountIn) {
      const t = await erc.approve(A.PERMIT2, 2n ** 256n - 1n, await feeOverrides(provider));
      await t.wait();
      costWei += (await txCostEth(provider, t.hash)).wei;
    }
    commands.push(CMD.PERMIT2_PERMIT);
    inputs.push(await permitInput(wallet, d.currencyIn, amountIn));
  }
  commands.push(CMD.V4_SWAP);
  inputs.push(v4SwapInput(k, d, amountIn, minOut));
  const cmdBytes = "0x" + commands.map((c) => c.toString(16).padStart(2, "0")).join("");
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const outToken = new Contract(d.currencyOut, ERC20_ABI, provider);
  const balBefore = lc(d.currencyOut) === ZeroAddress ? await provider.getBalance(wallet.address) : await outToken.balanceOf(wallet.address);
  const gas = await ur.execute.estimateGas(cmdBytes, inputs, deadline, { value });
  const tx = await ur.execute(cmdBytes, inputs, deadline, { value, gasLimit: (gas * 13n) / 10n, ...(await feeOverrides(provider)) });
  await tx.wait();
  const c = await txCostEth(provider, tx.hash);
  costWei += c.wei;
  if (!c.status) throw new Error(`swap reverted (tx ${tx.hash})`);
  const balAfter = lc(d.currencyOut) === ZeroAddress ? await provider.getBalance(wallet.address) : await outToken.balanceOf(wallet.address);
  let amountOut = balAfter - balBefore;
  if (lc(d.currencyOut) === ZeroAddress) amountOut += c.wei; // the ETH balance also paid this tx's fee: add it back to get the swap output
  return { hash: tx.hash, amountOut, costWei };
}

/**
 * Sell simulation for a V4 pool (read-only): quotes a small buy and then the sale of what it would return, through the pool's hook.
 * ratio = ETH back / ETH spent (~0.98 for a normal pool, ~0 when the hook blocks or confiscates sells).
 * Returns null when it cannot be simulated (pool not quoted in ETH/WETH, no liquidity at the current price, ...).
 */
async function v4Sellability(provider, { pool, poolBlock, token, probeWei = 10n ** 14n }) {
  try {
    const k = await poolKeyFromChain(provider, pool, poolBlock);
    assertPoolId(k, pool);
    const d = direction(k, token, true);
    if (![ZeroAddress, ADDRESSES.WETH.toLowerCase()].includes(lc(d.quote))) return null;
    const out = await quote(provider, k, token, true, probeWei);
    let back = 0n;
    try { back = await quote(provider, k, token, false, out); } catch { back = 0n; } // a sale that reverts is as bad as one that returns nothing
    return { ratio: Number((back * 10000n) / probeWei) / 10000, hooks: k.hooks, fee: k.fee, tickSpacing: k.tickSpacing };
  } catch { return null; }
}

/** Makes sure the wallet holds at least `needWei` of native ETH (plus a gas reserve) by unwrapping WETH if necessary. */
async function ensureEth(wallet, needWei, reserveWei) {
  const bal = await wallet.provider.getBalance(wallet.address);
  if (bal >= needWei + reserveWei) return { costWei: 0n, unwrapped: 0n };
  const weth = new Contract(ADDRESSES.WETH, WETH_ABI, wallet);
  const wbal = await weth.balanceOf(wallet.address);
  const want = needWei * 4n + reserveWei - bal; // unwrap a few trades at once to save gas
  const amt = want > wbal ? wbal : want;
  if (bal + amt < needWei + reserveWei) throw new Error("not enough ETH+WETH in the wallet");
  const t = await weth.withdraw(amt, await feeOverrides(wallet.provider));
  await t.wait();
  return { costWei: (await txCostEth(wallet.provider, t.hash)).wei, unwrapped: amt };
}

module.exports = { A, v4Sellability, feeOverrides, loadWallet, ethUsd, poolKeyFromChain, assertPoolId, direction, quote, swap, ensureEth, parseEther, formatEther, getAddress };
