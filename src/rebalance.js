import { ethers } from "ethers";
import { notify } from "./chatwork.js";
import {
  BASE,
  FEE_TIER,
  TICK_SPACING,
  ERC20_ABI,
  getPoolAddress,
  getCurrentTick,
  getPosition,
  isInRange,
  calcRangeTicks,
  decreaseAndCollect,
  swapExactInput,
  mintNewPosition,
  increaseLiquidity,
  wrapETH,
} from "./uniswap.js";

const RANGE_WIDTH_PCT = Number(process.env.RANGE_WIDTH_PCT || 15);
const GAS_RESERVE_ETH = ethers.parseEther(process.env.GAS_RESERVE_ETH || "0.002");
const MIN_REBALANCE_USD = Number(process.env.MIN_REBALANCE_USD || 30);
const DRY_RUN = process.env.DRY_RUN === "true";

function fmtUSDC(amount) {
  return Number(ethers.formatUnits(amount, 6)).toFixed(2);
}

function fmtETH(amount) {
  return Number(ethers.formatEther(amount)).toFixed(6);
}

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  const tokenIdEnv = process.env.TOKEN_ID;

  if (!rpcUrl || !privateKey) {
    throw new Error("BASE_RPC_URL and PRIVATE_KEY are required");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`[bot] wallet: ${wallet.address}`);

  const [token0, token1] =
    BASE.USDC.toLowerCase() < BASE.WETH.toLowerCase()
      ? [BASE.USDC, BASE.WETH]
      : [BASE.WETH, BASE.USDC];

  const poolAddress = await getPoolAddress(provider, token0, token1, FEE_TIER);
  if (poolAddress === ethers.ZeroAddress) {
    throw new Error("Pool not found for USDC/WETH 0.05%");
  }
  console.log(`[bot] pool: ${poolAddress}`);

  const currentTick = await getCurrentTick(provider, poolAddress);
  console.log(`[bot] currentTick: ${currentTick}`);

  const usdc = new ethers.Contract(BASE.USDC, ERC20_ABI, provider);
  const weth = new ethers.Contract(BASE.WETH, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet.address);
  const wethBal = await weth.balanceOf(wallet.address);
  const ethBal = await provider.getBalance(wallet.address);

  console.log(`[bot] balances - USDC: ${fmtUSDC(usdcBal)}, WETH: ${fmtETH(wethBal)}, ETH: ${fmtETH(ethBal)}`);

  if (ethBal < GAS_RESERVE_ETH) {
    const msg = `Gas reserve too low: ${fmtETH(ethBal)} ETH (need ${fmtETH(GAS_RESERVE_ETH)})`;
    console.error(`[bot] ${msg}`);
    await notify(`⚠️ ${msg}\nWallet: ${wallet.address}`);
    return;
  }

  let tokenId = tokenIdEnv ? BigInt(tokenIdEnv) : null;
  let position = null;

  if (tokenId) {
    try {
      position = await getPosition(provider, tokenId);
      console.log(`[bot] position #${tokenId}: tick [${position.tickLower}, ${position.tickUpper}], liquidity ${position.liquidity}`);
    } catch (e) {
      console.warn(`[bot] failed to load position #${tokenId}: ${e.message}`);
      tokenId = null;
    }
  }

  const inRange = position ? isInRange(currentTick, position.tickLower, position.tickUpper) : false;
  const ethSpendable = ethBal > GAS_RESERVE_ETH ? ethBal - GAS_RESERVE_ETH : 0n;
  const hasIdleFunds = usdcBal > 1_000_000n || wethBal > ethers.parseEther("0.0005") || ethSpendable > ethers.parseEther("0.0005");

  if (position && inRange && !hasIdleFunds) {
    const msg = `In range, no idle funds. Skip.\nTick: ${currentTick} in [${position.tickLower}, ${position.tickUpper}]`;
    console.log(`[bot] ${msg}`);
    if (process.env.NOTIFY_SKIP === "true") await notify(`✓ ${msg}`);
    return;
  }

  if (DRY_RUN) {
    const summary =
      `DRY RUN\n` +
      `currentTick: ${currentTick}\n` +
      `position: ${position ? `#${tokenId} [${position.tickLower}, ${position.tickUpper}] inRange=${inRange}` : "none"}\n` +
      `balances: USDC=${fmtUSDC(usdcBal)} WETH=${fmtETH(wethBal)} ETH=${fmtETH(ethBal)}\n` +
      `hasIdleFunds: ${hasIdleFunds}\n` +
      `action: ${!position ? "MINT_NEW" : !inRange ? "REBALANCE" : "ADD_LIQUIDITY"}`;
    console.log(`[bot] ${summary}`);
    await notify(summary);
    return;
  }

  let actionTaken = "";
  let txHashes = [];

  if (position && !inRange) {
    console.log("[bot] out of range, decreasing & collecting...");
    const hash = await decreaseAndCollect(wallet, tokenId, position);
    txHashes.push(`decrease+collect: ${hash}`);
    actionTaken = "REBALANCE";
    position = null;
  }

  const ethBalNow = await provider.getBalance(wallet.address);
  const ethToWrap = ethBalNow > GAS_RESERVE_ETH ? ethBalNow - GAS_RESERVE_ETH : 0n;
  if (ethToWrap > ethers.parseEther("0.0005")) {
    console.log(`[bot] wrapping ${fmtETH(ethToWrap)} ETH -> WETH...`);
    const wrapHash = await wrapETH(wallet, ethToWrap);
    txHashes.push(`wrap: ${wrapHash}`);
  }

  const wethBalForLP = await weth.balanceOf(wallet.address);
  const usdcBalForLP = await usdc.balanceOf(wallet.address);

  const targetTicks = calcRangeTicks(currentTick, RANGE_WIDTH_PCT, TICK_SPACING);
  console.log(`[bot] target range: [${targetTicks.tickLower}, ${targetTicks.tickUpper}]`);

  const needSwapToBalance = await rebalanceTokens(
    wallet,
    provider,
    poolAddress,
    usdcBalForLP,
    wethBalForLP,
    currentTick,
    targetTicks
  );
  if (needSwapToBalance.txHash) {
    txHashes.push(`swap: ${needSwapToBalance.txHash}`);
  }

  const usdcFinal = await usdc.balanceOf(wallet.address);
  const wethFinal = await weth.balanceOf(wallet.address);

  if (usdcFinal < 100_000n && wethFinal < ethers.parseEther("0.00005")) {
    const msg = `Final balance too small to mint LP. USDC=${fmtUSDC(usdcFinal)} WETH=${fmtETH(wethFinal)}`;
    console.warn(`[bot] ${msg}`);
    await notify(`⚠️ ${msg}`);
    return;
  }

  if (!actionTaken) actionTaken = position ? "ADD_LIQUIDITY" : "MINT_NEW";

  if (position && tokenId && actionTaken === "ADD_LIQUIDITY") {
    console.log("[bot] increasing liquidity on existing position...");
    const [a0, a1] =
      token0 === BASE.USDC ? [usdcFinal, wethFinal] : [wethFinal, usdcFinal];
    const hash = await increaseLiquidity(wallet, tokenId, a0, a1);
    txHashes.push(`increase: ${hash}`);
  } else {
    console.log("[bot] minting new position...");
    const [a0, a1] =
      token0 === BASE.USDC ? [usdcFinal, wethFinal] : [wethFinal, usdcFinal];
    const result = await mintNewPosition(
      wallet,
      token0,
      token1,
      targetTicks.tickLower,
      targetTicks.tickUpper,
      a0,
      a1
    );
    txHashes.push(`mint: ${result.hash}`);
    if (result.tokenId) {
      console.log(`[bot] new tokenId: ${result.tokenId}`);
      txHashes.push(`NEW TOKEN_ID: ${result.tokenId} -> update GitHub Secret!`);
    }
  }

  const summary =
    `✓ ${actionTaken} done\n` +
    `Tick: ${currentTick}, Range: [${targetTicks.tickLower}, ${targetTicks.tickUpper}]\n` +
    `USDC: ${fmtUSDC(usdcFinal)}, WETH: ${fmtETH(wethFinal)}\n` +
    `TX:\n${txHashes.join("\n")}`;
  console.log(`[bot] ${summary}`);
  await notify(summary);
}

async function rebalanceTokens(wallet, provider, poolAddress, usdcBal, wethBal, currentTick, targetTicks) {
  const sqrtPriceX96 = (await new ethers.Contract(poolAddress, [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  ], provider).slot0()).sqrtPriceX96;

  const Q96 = 2n ** 96n;
  const priceX96 = (sqrtPriceX96 * sqrtPriceX96) / Q96;
  const ethPriceUSDC = Number(priceX96) / Number(Q96) * 1e12;

  const usdcValue = Number(ethers.formatUnits(usdcBal, 6));
  const wethValueUSDC = Number(ethers.formatEther(wethBal)) * ethPriceUSDC;
  const totalUSDC = usdcValue + wethValueUSDC;
  const targetEach = totalUSDC / 2;

  console.log(`[bot] valuation: USDC=$${usdcValue.toFixed(2)}, WETH=$${wethValueUSDC.toFixed(2)}, target each=$${targetEach.toFixed(2)}`);

  if (Math.abs(usdcValue - targetEach) < totalUSDC * 0.02) {
    return { txHash: null };
  }

  if (usdcValue > targetEach) {
    const swapUSDC = ((usdcValue - targetEach));
    const amountIn = ethers.parseUnits(swapUSDC.toFixed(6), 6);
    console.log(`[bot] swapping ${swapUSDC.toFixed(2)} USDC -> WETH`);
    const hash = await swapExactInput(wallet, BASE.USDC, BASE.WETH, amountIn);
    return { txHash: hash };
  } else {
    const swapWETHValue = wethValueUSDC - targetEach;
    const swapWETH = swapWETHValue / ethPriceUSDC;
    const amountIn = ethers.parseEther(swapWETH.toFixed(18));
    console.log(`[bot] swapping ${swapWETH.toFixed(6)} WETH -> USDC`);
    const hash = await swapExactInput(wallet, BASE.WETH, BASE.USDC, amountIn);
    return { txHash: hash };
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await notify(`❌ ERROR: ${e.message}\n${e.stack?.split("\n").slice(0, 3).join("\n")}`);
    process.exit(1);
  });
