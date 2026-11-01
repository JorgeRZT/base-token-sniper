require("dotenv").config();
const { JsonRpcProvider, Contract } = require("ethers");

// Uniswap deployments on Base (chainId 8453)
// https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
const ADDRESSES = {
  V2_FACTORY: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  V3_FACTORY: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  V4_POOL_MANAGER: "0x498581fF718922c3f8e6A244956aF099B2652b2b", // verified on-chain (code + Initialize events)
  NATIVE_ETH: "0x0000000000000000000000000000000000000000", // V4 uses address(0) for native ETH
};

function getProvider() {
  const key = process.env.INFURA_API_KEY;
  const url = process.env.BASE_RPC_URL || (key && `https://base-mainnet.infura.io/v3/${key}`);
  if (!url) throw new Error("Missing INFURA_API_KEY. Copy .env.example to .env and fill it in.");
  return new JsonRpcProvider(url, 8453, { staticNetwork: true });
}

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

/** Best-effort token metadata (some tokens are non-standard). */
async function tokenInfo(provider, address) {
  const c = new Contract(address, ERC20_ABI, provider);
  const [name, symbol, decimals] = await Promise.all([
    c.name().catch(() => "?"),
    c.symbol().catch(() => "?"),
    c.decimals().catch(() => null),
  ]);
  return { address, name, symbol, decimals: decimals === null ? null : Number(decimals) };
}

/** Given a pair of tokens, returns the one that is NOT a base asset (WETH/USDC/native ETH), if any. */
function pickNewToken(a, b) {
  const base = new Set([ADDRESSES.WETH, ADDRESSES.USDC, ADDRESSES.NATIVE_ETH].map((x) => x.toLowerCase()));
  if (base.has(a.toLowerCase()) && !base.has(b.toLowerCase())) return b;
  if (base.has(b.toLowerCase()) && !base.has(a.toLowerCase())) return a;
  return null; // neither / both are base assets
}

module.exports = { ADDRESSES, getProvider, tokenInfo, pickNewToken };
