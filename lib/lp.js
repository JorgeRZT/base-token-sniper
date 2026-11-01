// Who holds the liquidity-provider position of a pool? (burned / contract / wallet)
//  V2: LP tokens are ERC-20 held by wallets (rebuilt from Transfer events of the pair).
//  V3: positions are NFTs (NonfungiblePositionManager); we resolve the NFT owner.
//  V4: positions are NFTs (PositionManager); pool liquidity is attributed per (sender, salt) from ModifyLiquidity events.
// "Locked" = burned, or held by an address in LOCKER_ADDRESSES. A contract owner is reported separately
// because it may be a locker we do not know (verify manually).
const { Contract, Interface, id, getAddress } = require("ethers");
const { ADDRESSES } = require("./config");

const NFPM_V3 = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"; // verified on Base
const POSM_V4 = "0x7C5f5A4bBd8fD63184577525326123B519429bDc"; // verified on Base
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const T = {
  transfer: id("Transfer(address,address,uint256)"),
  v3Mint: id("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  v3Inc: id("IncreaseLiquidity(uint256,uint128,uint256,uint256)"),
  v4Mod: id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
};
const iface = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
const nftAbi = [
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
];

const lockers = () => new Set((process.env.LOCKER_ADDRESSES || "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));

async function nftOwner(nft, tokenId) {
  try { return (await nft.ownerOf(tokenId)).toLowerCase(); } catch { return ZERO; } // burned NFT => ownerOf reverts
}

/** Returns weights: Map<ownerAddressLowercase, bigint> */
async function collectWeights(provider, { version, pool, token0, token1, fee, fromBlock }) {
  const w = new Map();
  w.sawAdd = false; // true if liquidity was ever added (so an empty result means it was removed)
  const add = (o, v) => { if (v > 0n) w.set(o, (w.get(o) || 0n) + v); };

  if (version === "v2") {
    const logs = await provider.getLogs({ address: pool, topics: [T.transfer], fromBlock, toBlock: "latest" });
    const bal = new Map();
    for (const l of logs) {
      const e = iface.parseLog(l);
      const f = e.args.from.toLowerCase(), t = e.args.to.toLowerCase();
      if (f === ZERO && t !== ZERO) w.sawAdd = true;
      if (f !== ZERO) bal.set(f, (bal.get(f) || 0n) - e.args.value);
      bal.set(t, (bal.get(t) || 0n) + e.args.value);
    }
    for (const [o, b] of bal) add(o, b);
    w.delete(ZERO); // V2 permanently locks 1000 wei of LP at address(0) on the first mint; ignore it
  } else if (version === "v3") {
    const nft = new Contract(NFPM_V3, nftAbi, provider);
    const mints = (await provider.getLogs({ address: pool, topics: [T.v3Mint], fromBlock, toBlock: "latest" })).map((l) => ({ l, e: iface.parseLog(l) }));
    w.sawAdd = mints.length > 0;
    const viaNft = mints.filter((m) => m.e.args.owner.toLowerCase() === NFPM_V3.toLowerCase());
    for (const m of mints) if (!viaNft.includes(m)) add(m.e.args.owner.toLowerCase(), m.e.args.amount);
    if (viaNft.length) {
      const blocks = viaNft.map((m) => m.l.blockNumber);
      const inc = await provider.getLogs({ address: NFPM_V3, topics: [T.v3Inc], fromBlock: Math.min(...blocks), toBlock: Math.max(...blocks) });
      const wanted = new Set(viaNft.map((m) => m.l.transactionHash));
      const tokenIds = new Set(inc.filter((l) => wanted.has(l.transactionHash)).map((l) => iface.parseLog(l).args.tokenId));
      for (const tokenId of tokenIds) {
        const p = await nft.positions(tokenId).catch(() => null);
        if (!p || p[2].toLowerCase() !== token0.toLowerCase() || p[3].toLowerCase() !== token1.toLowerCase() || Number(p[4]) !== fee) continue;
        add(await nftOwner(nft, tokenId), p[7]); // current liquidity of the position
      }
    }
  } else {
    const nft = new Contract(POSM_V4, nftAbi, provider);
    const logs = await provider.getLogs({ address: ADDRESSES.V4_POOL_MANAGER, topics: [T.v4Mod, pool], fromBlock, toBlock: "latest" });
    const net = new Map(); // sender|salt|ticks -> net liquidity
    for (const l of logs) {
      const e = iface.parseLog(l);
      const k = [e.args.sender, e.args.salt, e.args.tickLower, e.args.tickUpper].join("|");
      net.set(k, (net.get(k) || 0n) + e.args.liquidityDelta);
      if (e.args.liquidityDelta > 0n) w.sawAdd = true;
    }
    for (const [k, liq] of net) {
      if (liq <= 0n) continue;
      const [sender, salt] = k.split("|");
      if (sender.toLowerCase() === POSM_V4.toLowerCase()) add(await nftOwner(nft, BigInt(salt)), liq);
      else add(sender.toLowerCase(), liq); // direct sender (router / hook / custom contract)
    }
  }
  return w;
}

/** @returns null if unavailable, {removed:true} if all liquidity was pulled, else {lockedPct, contractPct, walletPct, topOwner, topKind} */
async function analyzeLp(provider, args) {
  try {
    const w = await collectWeights(provider, args);
    let total = 0n;
    for (const v of w.values()) total += v;
    if (total === 0n) return w.sawAdd ? { removed: true } : null; // removed after being added, or not added yet

    const lk = lockers();
    const sums = { locked: 0n, contract: 0n, wallet: 0n };
    let top = { v: 0n };
    for (const [o, v] of w) {
      let kind;
      if (o === ZERO || o === DEAD || lk.has(o)) kind = "locked";
      else kind = (await provider.getCode(o)) !== "0x" ? "contract" : "wallet";
      sums[kind] += v;
      if (v > top.v) top = { v, o, kind };
    }
    const pct = (b) => Number((b * 10000n) / total) / 100;
    return { lockedPct: pct(sums.locked), contractPct: pct(sums.contract), walletPct: pct(sums.wallet), topOwner: getAddress(top.o), topKind: top.kind };
  } catch (e) { return null; }
}

module.exports = { analyzeLp };
