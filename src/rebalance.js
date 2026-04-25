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
  unwrapWETH,
} from "./uniswap.js";

const RANGE_WIDTH_PCT = Number(process.env.RANGE_WIDTH_PCT || 15);
const GAS_RESERVE_ETH = ethers.parseEther(process.env.GAS_RESERVE_ETH || "0.002");
const MIN_REBALANCE_USD = Number(process.env.MIN_REBALANCE_USD || 30);
const COMMAND = (process.env.COMMAND || "auto").toLowerCase();
const DRY_RUN = process.env.DRY_RUN === "true" || COMMAND === "dry_run";

function fmtUSDC(amount) {
  return Number(ethers.formatUnits(amount, 6)).toFixed(2);
}

function fmtETH(amount) {
  return Number(ethers.formatEther(amount)).toFixed(6);
}

async function getEthPriceUSDC(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  ], provider);
  const slot0 = await pool.slot0();
  const sqrtPriceX96 = slot0.sqrtPriceX96;
  const Q96 = 2n ** 96n;
  const priceX96 = (sqrtPriceX96 * sqrtPriceX96) / Q96;
  return Number(priceX96) / Number(Q96) * 1e12;
}

async function loadContext() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  const tokenIdEnv = process.env.TOKEN_ID;

  if (!rpcUrl || !privateKey) {
    throw new Error("BASE_RPC_URL and PRIVATE_KEY are required");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const [token0, token1] =
    BASE.USDC.toLowerCase() < BASE.WETH.toLowerCase()
      ? [BASE.USDC, BASE.WETH]
      : [BASE.WETH, BASE.USDC];

  const poolAddress = await getPoolAddress(provider, token0, token1, FEE_TIER);
  if (poolAddress === ethers.ZeroAddress) throw new Error("Pool not found");

  const currentTick = await getCurrentTick(provider, poolAddress);
  const ethPriceUSDC = await getEthPriceUSDC(provider, poolAddress);

  const usdc = new ethers.Contract(BASE.USDC, ERC20_ABI, provider);
  const weth = new ethers.Contract(BASE.WETH, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet.address);
  const wethBal = await weth.balanceOf(wallet.address);
  const ethBal = await provider.getBalance(wallet.address);

  let tokenId = tokenIdEnv ? BigInt(tokenIdEnv) : null;
  let position = null;
  if (tokenId) {
    try {
      position = await getPosition(provider, tokenId);
    } catch (e) {
      console.warn(`[bot] failed to load position #${tokenId}: ${e.message}`);
      tokenId = null;
    }
  }

  return { provider, wallet, token0, token1, poolAddress, currentTick, ethPriceUSDC, usdc, weth, usdcBal, wethBal, ethBal, tokenId, position };
}

async function cmdStatus(ctx) {
  const { wallet, currentTick, ethPriceUSDC, usdcBal, wethBal, ethBal, tokenId, position } = ctx;
  const totalUSD =
    Number(ethers.formatUnits(usdcBal, 6)) +
    Number(ethers.formatEther(wethBal)) * ethPriceUSDC +
    Number(ethers.formatEther(ethBal)) * ethPriceUSDC;

  let posInfo = "なし";
  if (position) {
    const inRange = isInRange(currentTick, position.tickLower, position.tickUpper);
    posInfo = `#${tokenId} liquidity=${position.liquidity} range=[${position.tickLower}, ${position.tickUpper}] inRange=${inRange ? "✓" : "✗"} owed=USDC ${fmtUSDC(position.tokensOwed0 || 0n)} WETH ${fmtETH(position.tokensOwed1 || 0n)}`;
  }

  const msg =
    `📊 STATUS\n` +
    `Wallet: ${wallet.address}\n` +
    `ETH price: $${ethPriceUSDC.toFixed(2)}\n` +
    `Current tick: ${currentTick}\n` +
    `Position: ${posInfo}\n` +
    `Wallet balances:\n` +
    `  USDC: ${fmtUSDC(usdcBal)}\n` +
    `  WETH: ${fmtETH(wethBal)}\n` +
    `  ETH:  ${fmtETH(ethBal)}\n` +
    `Total wallet value: $${totalUSD.toFixed(2)}`;

  console.log(msg);
  await notify(msg);
}

async function cmdCloseAll(ctx) {
  const { wallet, provider, usdc, weth, tokenId, position } = ctx;
  const txHashes = [];

  if (!position || position.liquidity === 0n) {
    const msg = position ? `Position #${tokenId} has zero liquidity, skipping decrease.` : "No active position to close.";
    console.log(`[bot] ${msg}`);
    if (!position) {
      await notify(`ℹ️ CLOSE_ALL: ${msg}`);
      return;
    }
  }

  if (position && position.liquidity > 0n) {
    console.log("[bot] decreasing & collecting full position...");
    const hash = await decreaseAndCollect(wallet, tokenId, position);
    txHashes.push(`decrease+collect: ${hash}`);
  }

  const wethBalAfter = await weth.balanceOf(wallet.address);
  if (wethBalAfter > 0n) {
    console.log(`[bot] unwrapping ${fmtETH(wethBalAfter)} WETH -> ETH...`);
    const hash = await unwrapWETH(wallet, wethBalAfter);
    txHashes.push(`unwrap: ${hash}`);
  }

  const usdcFinal = await usdc.balanceOf(wallet.address);
  const ethFinal = await provider.getBalance(wallet.address);

  const msg =
    `✓ CLOSE_ALL done\n` +
    `Wallet now holds:\n` +
    `  USDC: ${fmtUSDC(usdcFinal)}\n` +
    `  ETH:  ${fmtETH(ethFinal)}\n` +
    `TX:\n${txHashes.join("\n")}\n\n` +
    `⚠️ TOKEN_ID Secret を空にして自動cronを止めるか、再運用するなら新規mintしてください`;

  console.log(msg);
  await notify(msg);
}

async function cmdAuto(ctx, opts = { force: false }) {
  const { wallet, provider, token0, token1, poolAddress, currentTick, usdc, weth, usdcBal, wethBal, ethBal, tokenId, position } = ctx;

  const inRange = position ? isInRange(currentTick, position.tickLower, position.tickUpper) : false;
  const ethSpendable = ethBal > GAS_RESERVE_ETH ? ethBal - GAS_RESERVE_ETH : 0n;
  const hasIdleFunds = usdcBal > 1_000_000n || wethBal > ethers.parseEther("0.0005") || ethSpendable > ethers.parseEther("0.0005");

  console.log(`[bot] balances - USDC: ${fmtUSDC(usdcBal)}, WETH: ${fmtETH(wethBal)}, ETH: ${fmtETH(ethBal)}`);
  console.log(`[bot] currentTick: ${currentTick}, position: ${position ? `#${tokenId} [${position.tickLower}, ${position.tickUpper}] inRange=${inRange}` : "none"}`);

  if (ethBal < GAS_RESERVE_ETH) {
    const msg = `Gas reserve too low: ${fmtETH(ethBal)} ETH (need ${fmtETH(GAS_RESERVE_ETH)})`;
    console.error(`[bot] ${msg}`);
    await notify(`⚠️ ${msg}\nWallet: ${wallet.address}`);
    return;
  }

  if (position && inRange && !hasIdleFunds && !opts.force) {
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
      `force: ${opts.force}\n` +
      `action: ${!position ? "MINT_NEW" : (!inRange || opts.force) ? "REBALANCE" : "ADD_LIQUIDITY"}`;
    console.log(`[bot] ${summary}`);
    await notify(summary);
    return;
  }

  let actionTaken = "";
  const txHashes = [];
  let positionLocal = position;

  const needRebalance = positionLocal && (!inRange || opts.force);

  if (needRebalance) {
    console.log(`[bot] ${opts.force ? "force rebalance" : "out of range"}, decreasing & collecting...`);
    const hash = await decreaseAndCollect(wallet, tokenId, positionLocal);
    txHashes.push(`decrease+collect: ${hash}`);
    actionTaken = opts.force ? "FORCE_REBALANCE" : "REBALANCE";
    positionLocal = null;
  }

  const ethBalNow = await provider.getBalance(wallet.address);
  const ethToWrap = ethBalNow > GAS_RESERVE_ETH ? ethBalNow - GAS_RESERVE_ETH : 0n;
  if (ethToWrap > ethers.parseEther("0.0005")) {
    console.log(`[bot] wrapping ${fmtETH(ethToWrap)} ETH -> WETH...`);
    const wrapHash = await wrapETH(wallet, ethToWrap);
    txHashes.push(`wrap: ${wrapHash}`);
  }

  const usdcBalForLP = await usdc.balanceOf(wallet.address);
  const wethBalForLP = await weth.balanceOf(wallet.address);

  const targetTicks = calcRangeTicks(currentTick, RANGE_WIDTH_PCT, TICK_SPACING);
  console.log(`[bot] target range: [${targetTicks.tickLower}, ${targetTicks.tickUpper}]`);

  const swapResult = await rebalanceTokens(wallet, provider, poolAddress, usdcBalForLP, wethBalForLP, currentTick, targetTicks);
  if (swapResult.txHash) txHashes.push(`swap: ${swapResult.txHash}`);

  const usdcFinal = await usdc.balanceOf(wallet.address);
  const wethFinal = await weth.balanceOf(wallet.address);

  if (usdcFinal < 100_000n && wethFinal < ethers.parseEther("0.00005")) {
    const msg = `Final balance too small to mint LP. USDC=${fmtUSDC(usdcFinal)} WETH=${fmtETH(wethFinal)}`;
    console.warn(`[bot] ${msg}`);
    await notify(`⚠️ ${msg}`);
    return;
  }

  if (!actionTaken) actionTaken = positionLocal ? "ADD_LIQUIDITY" : "MINT_NEW";

  if (positionLocal && tokenId && actionTaken === "ADD_LIQUIDITY") {
    console.log("[bot] increasing liquidity on existing position...");
    const [a0, a1] = token0 === BASE.USDC ? [usdcFinal, wethFinal] : [wethFinal, usdcFinal];
    const hash = await increaseLiquidity(wallet, tokenId, a0, a1);
    txHashes.push(`increase: ${hash}`);
  } else {
    console.log("[bot] minting new position...");
    const [a0, a1] = token0 === BASE.USDC ? [usdcFinal, wethFinal] : [wethFinal, usdcFinal];
    const result = await mintNewPosition(wallet, token0, token1, targetTicks.tickLower, targetTicks.tickUpper, a0, a1);
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
  const ethPriceUSDC = await getEthPriceUSDC(provider, poolAddress);

  const usdcValue = Number(ethers.formatUnits(usdcBal, 6));
  const wethValueUSDC = Number(ethers.formatEther(wethBal)) * ethPriceUSDC;
  const totalUSDC = usdcValue + wethValueUSDC;
  const targetEach = totalUSDC / 2;

  console.log(`[bot] valuation: USDC=$${usdcValue.toFixed(2)}, WETH=$${wethValueUSDC.toFixed(2)}, target each=$${targetEach.toFixed(2)}`);

  if (totalUSDC < 1 || Math.abs(usdcValue - targetEach) < totalUSDC * 0.02) {
    return { txHash: null };
  }

  if (usdcValue > targetEach) {
    const swapUSDC = usdcValue - targetEach;
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

async function main() {
  console.log(`[bot] command: ${COMMAND}, dryRun: ${DRY_RUN}`);
  const ctx = await loadContext();
  console.log(`[bot] wallet: ${ctx.wallet.address}, pool: ${ctx.poolAddress}`);

  switch (COMMAND) {
    case "status":
      await cmdStatus(ctx);
      break;
    case "close_all":
      await cmdCloseAll(ctx);
      break;
    case "force_rebalance":
      await cmdAuto(ctx, { force: true });
      break;
    case "auto":
    case "dry_run":
    default:
      await cmdAuto(ctx, { force: false });
      break;
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await notify(`❌ ERROR: ${e.message}\n${e.stack?.split("\n").slice(0, 3).join("\n")}`);
    process.exit(1);
  });
