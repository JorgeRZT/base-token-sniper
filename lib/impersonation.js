// Detects tokens that copy the name/symbol of well-known tokens or brands.
// Canonical addresses below were verified on Base (symbol/name/decimals read on-chain).
const KNOWN = [
  ["WETH", "Wrapped Ether", "0x4200000000000000000000000000000000000006"],
  ["USDC", "USD Coin", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  ["cbBTC", "Coinbase Wrapped BTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"],
  ["cbETH", "Coinbase Wrapped Staked ETH", "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22"],
  ["DAI", "Dai Stablecoin", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"],
  ["USDbC", "USD Base Coin", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"],
  ["USDT", "Tether USD", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"],
  ["WBTC", "Wrapped BTC", "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c"],
  ["AERO", "Aerodrome", "0x940181a94A35A4569E4529A3CDfB74e38FD98631"],
  ["VIRTUAL", "Virtual Protocol", "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b"],
  ["DEGEN", "Degen", "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"],
  ["BRETT", "Brett", "0x532f27101965dd16442E59d40670FaF5eBB142E4"],
];
// Extra generic names scammers reuse (no canonical Base token to compare against).
const GENERIC = ["eth", "btc", "usd", "usdc", "usdt", "weth", "wbtc", "lusd", "ethereum", "bitcoin", "tether"];
const BRANDS = ["anthropic", "openai", "chatgpt", "claude", "spacex", "tesla", "nvidia", "coinbase", "binance", "google", "microsoft", "uniswap"];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** @returns {{reject: string|null, brand: string|null}} */
function checkImpersonation({ address, name, symbol }) {
  const n = norm(name), s = norm(symbol), addr = address.toLowerCase();
  for (const [ksym, kname, kaddr] of KNOWN) {
    if (kaddr.toLowerCase() === addr) return { reject: null, brand: null };
    if (s === norm(ksym) || n === norm(kname)) return { reject: `impersonates ${ksym} (real: ${kaddr})`, brand: null };
  }
  if (GENERIC.includes(s) || GENERIC.includes(n)) return { reject: `uses the generic name/symbol "${symbol}"`, brand: null };
  const brand = BRANDS.find((b) => n.includes(b) || s.includes(b));
  return { reject: null, brand: brand || null };
}

module.exports = { checkImpersonation, norm };
