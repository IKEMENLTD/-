import { ethers } from "ethers";

export const BASE = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  V3_FACTORY: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  NPM: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  SWAP_ROUTER_02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  POOL_USDC_WETH_005: null,
};

export const FEE_TIER = 500;
export const TICK_SPACING = 10;

export const NPM_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) external payable",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
];

export const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
];

export const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

export const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
];

export function tickToPrice(tick, decimals0, decimals1) {
  const ratio = Math.pow(1.0001, tick);
  const adjusted = ratio * Math.pow(10, decimals0 - decimals1);
  return adjusted;
}

export function priceToTick(price, decimals0, decimals1) {
  const adjusted = price / Math.pow(10, decimals0 - decimals1);
  const tick = Math.log(adjusted) / Math.log(1.0001);
  return Math.floor(tick);
}

export function alignTick(tick, spacing) {
  return Math.floor(tick / spacing) * spacing;
}

export function calcRangeTicks(currentTick, widthPct, spacing) {
  const widthRatio = Math.log(1 + widthPct / 100) / Math.log(1.0001);
  const tickLower = alignTick(currentTick - Math.floor(widthRatio), spacing);
  const tickUpper = alignTick(currentTick + Math.floor(widthRatio), spacing);
  return { tickLower, tickUpper };
}

export async function getPoolAddress(provider, token0, token1, fee) {
  const factory = new ethers.Contract(BASE.V3_FACTORY, FACTORY_ABI, provider);
  return await factory.getPool(token0, token1, fee);
}

export async function getCurrentTick(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const slot0 = await pool.slot0();
  return Number(slot0.tick);
}

export async function getPosition(provider, tokenId) {
  const npm = new ethers.Contract(BASE.NPM, NPM_ABI, provider);
  const p = await npm.positions(tokenId);
  return {
    token0: p.token0,
    token1: p.token1,
    fee: Number(p.fee),
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: p.liquidity,
    tokensOwed0: p.tokensOwed0,
    tokensOwed1: p.tokensOwed1,
  };
}

export function isInRange(currentTick, tickLower, tickUpper) {
  return currentTick >= tickLower && currentTick <= tickUpper;
}

export async function ensureApproval(wallet, tokenAddress, spender, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const current = await token.allowance(wallet.address, spender);
  if (current >= amount) return null;
  const tx = await token.approve(spender, ethers.MaxUint256);
  await tx.wait();
  return tx.hash;
}

export async function decreaseAndCollect(wallet, tokenId, position) {
  const npm = new ethers.Contract(BASE.NPM, NPM_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  if (position.liquidity > 0n) {
    const decTx = await npm.decreaseLiquidity({
      tokenId,
      liquidity: position.liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline,
    });
    await decTx.wait();
  }

  const collectTx = await npm.collect({
    tokenId,
    recipient: wallet.address,
    amount0Max: 2n ** 128n - 1n,
    amount1Max: 2n ** 128n - 1n,
  });
  const receipt = await collectTx.wait();
  return receipt.hash;
}

export async function swapExactInput(wallet, tokenIn, tokenOut, amountIn, slippageBps = 100) {
  const router = new ethers.Contract(BASE.SWAP_ROUTER_02, SWAP_ROUTER_ABI, wallet);
  await ensureApproval(wallet, tokenIn, BASE.SWAP_ROUTER_02, amountIn);

  const tx = await router.exactInputSingle({
    tokenIn,
    tokenOut,
    fee: FEE_TIER,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  });
  const receipt = await tx.wait();
  return receipt.hash;
}

export async function mintNewPosition(wallet, token0, token1, tickLower, tickUpper, amount0, amount1) {
  const npm = new ethers.Contract(BASE.NPM, NPM_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  await ensureApproval(wallet, token0, BASE.NPM, amount0);
  await ensureApproval(wallet, token1, BASE.NPM, amount1);

  const tx = await npm.mint({
    token0,
    token1,
    fee: FEE_TIER,
    tickLower,
    tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0,
    amount1Min: 0,
    recipient: wallet.address,
    deadline,
  });
  const receipt = await tx.wait();

  const transferLog = receipt.logs.find(
    (l) => l.topics[0] === ethers.id("Transfer(address,address,uint256)") && l.address.toLowerCase() === BASE.NPM.toLowerCase()
  );
  const newTokenId = transferLog ? BigInt(transferLog.topics[3]) : null;

  return { hash: receipt.hash, tokenId: newTokenId };
}

export async function increaseLiquidity(wallet, tokenId, amount0, amount1) {
  const npm = new ethers.Contract(BASE.NPM, NPM_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const pos = await getPosition(wallet, tokenId);
  await ensureApproval(wallet, pos.token0, BASE.NPM, amount0);
  await ensureApproval(wallet, pos.token1, BASE.NPM, amount1);

  const tx = await npm.increaseLiquidity({
    tokenId,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0,
    amount1Min: 0,
    deadline,
  });
  const receipt = await tx.wait();
  return receipt.hash;
}
