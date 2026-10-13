import { ethers } from 'ethers';
import { getSigner } from './walletLib.js';
import { executeAtomicTrade } from './atomicFees.js';
import { calculateFees, resolveGasPrice, tryV3Quote, buildFlapBuyData, buildFlapSellData, getFlapTokenInfo } from './swap.js';

const V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const V3 = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const erc20 = new ethers.Interface([
  'function approve(address,uint256) returns(bool)',
  'function allowance(address,address) view returns(uint256)',
  'function balanceOf(address) view returns(uint256)',
  'function decimals() view returns(uint8)',
  'function symbol() view returns(string)',
]);
const v2 = new ethers.Interface([
  'function getAmountsOut(uint256,address[]) view returns(uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
]);
const v3 = new ethers.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256)',
  'function unwrapWETH9(uint256,address) payable',
  'function multicall(bytes[]) payable returns(bytes[])',
]);
const portal = new ethers.Interface(['function sell(address,uint256,uint256)']);
export function minimumOutput(amount, slippage) {
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 100)
    throw new Error('Slippage must be between 0 and 100%.');
  return amount * BigInt(10000 - Math.floor(slippage * 100)) / 10000n;
}
export async function approvalCalls(signer, tokenAddress, spender, amount) {
  const token = new ethers.Contract(tokenAddress, erc20, signer.provider);
  const allowance = await token.allowance(signer.address, spender);
  if (allowance >= amount) return [];
  const call = n => ({ target: tokenAddress, value: 0n, data: erc20.encodeFunctionData('approve', [spender, n]) });
  return allowance > 0n ? [call(0n), call(amount)] : [call(amount)];
}
async function execute(signer, calls, fees, buy, gross, telegramId, antiMev, gasMode) {
  return executeAtomicTrade(signer, calls, fees.policy, {
    buy, gross, telegramId, antiMev, gasPrice: resolveGasPrice(gasMode),
  });
}
export async function buyAtomicRoute(kind, privateKey, ca, bnb, slip, antiMev, gasMode, telegramId) {
  const signer = getSigner(privateKey);
  const fees = await calculateFees(bnb, telegramId);
  const gross = ethers.parseEther(String(bnb));
  const amount = gross - fees.feeWei;
  if (amount <= 0n) throw new Error('Trade amount does not cover its quoted fee.');
  const token = new ethers.Contract(ca, erc20, signer.provider);
  const [before, decimals, symbol] = await Promise.all([token.balanceOf(signer.address), token.decimals(), token.symbol()]);
  const deadline = Math.floor(Date.now() / 1000) + 120;
  let call;
  let quotedTokens = null;
  if (kind === 'v2') {
    const amounts = await new ethers.Contract(V2, v2, signer.provider).getAmountsOut(amount, [WBNB, ca]);
    quotedTokens = Number(ethers.formatUnits(amounts[1], decimals));
    call = { target: V2, value: amount, data: v2.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',
      [minimumOutput(amounts[1], slip), [WBNB, ca], signer.address, deadline]) };
  } else if (kind === 'v3') {
    const quote = await tryV3Quote(WBNB, ca, amount);
    if (!quote) throw new Error('No V3 liquidity found.');
    quotedTokens = Number(ethers.formatUnits(quote.amountOut, decimals));
    call = { target: V3, value: amount, data: v3.encodeFunctionData('exactInputSingle', [{
      tokenIn: WBNB, tokenOut: ca, fee: quote.fee, recipient: signer.address, amountIn: amount,
      amountOutMinimum: minimumOutput(quote.amountOut, slip), sqrtPriceLimitX96: 0n }]) };
  } else {
    // The source portal encoding is retained; fee collection no longer uses a second TX.
    call = { target: PORTAL, value: amount, data: buildFlapBuyData(ca, amount, 0n) };
    try {
      const output = await signer.provider.call({ to: PORTAL, from: signer.address, value: amount, data: call.data });
      if (output.length === 66) quotedTokens = Number(ethers.formatUnits(BigInt(output), decimals));
    } catch { /* Do not invent a quote if the external portal provides none. */ }
  }
  const result = await execute(signer, [call], fees, true, gross, telegramId, antiMev, gasMode);
  let tokensReceived = null;
  try {
    const after = await token.balanceOf(signer.address, { blockTag: result.blockNumber });
    tokensReceived = Number(ethers.formatUnits(after > before ? after - before : 0n, decimals));
  } catch { /* A post-confirmation read failure must never turn success into a repeatable failure. */ }
  return { ...result, swapBnb: Number(ethers.formatEther(amount)), tokensReceived, tokenSymbol: symbol, quotedTokens,
    router: kind === 'curve' ? 'Flap.sh Bonding Curve' : `PancakeSwap ${kind.toUpperCase()}` };
}
export async function sellAtomicRoute(kind, privateKey, ca, percent, slip, antiMev, gasMode, telegramId) {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('Sell percentage must be 1–100.');
  const signer = getSigner(privateKey);
  const amount = (await new ethers.Contract(ca, erc20, signer.provider).balanceOf(signer.address)) *
    BigInt(Math.floor(percent * 100)) / 10000n;
  if (amount <= 0n) throw new Error('No token balance to sell.');
  const fees = await calculateFees(0.01, telegramId); // Policy only: contract computes fees from ACTUAL BNB output.
  const target = kind === 'v2' ? V2 : kind === 'v3' ? V3 : PORTAL;
  const token = new ethers.Contract(ca, erc20, signer.provider);
  const [decimals, tokenSymbol] = await Promise.all([token.decimals(), token.symbol()]);
  let quotedGross = null;
  const calls = await approvalCalls(signer, ca, target, amount);
  let data;
  if (kind === 'v2') {
    const amounts = await new ethers.Contract(V2, v2, signer.provider).getAmountsOut(amount, [ca, WBNB]);
    quotedGross = amounts[1];
    data = v2.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',
      [amount, minimumOutput(amounts[1], slip), [ca, WBNB], signer.address, Math.floor(Date.now() / 1000) + 120]);
  } else if (kind === 'v3') {
    const quote = await tryV3Quote(ca, WBNB, amount);
    if (!quote) throw new Error('No V3 liquidity found.');
    quotedGross = quote.amountOut;
    const minimum = minimumOutput(quote.amountOut, slip);
    data = v3.encodeFunctionData('multicall', [[
      v3.encodeFunctionData('exactInputSingle', [{ tokenIn: ca, tokenOut: WBNB, fee: quote.fee,
        recipient: V3, amountIn: amount, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n }]),
      v3.encodeFunctionData('unwrapWETH9', [minimum, signer.address]),
    ]]);
  } else {
    const info = await getFlapTokenInfo(ca);
    data = info?.status >= 3 ? portal.encodeFunctionData('sell', [ca, amount, 0n])
      : buildFlapSellData(ca, amount, 0n);
  }
  calls.push({ target, value: 0n, data });
  let quotedBnb = null;
  if (quotedGross !== null) {
    const { quoteAtomicFees } = await import('./atomicFees.js');
    const quoteFee = await quoteAtomicFees(signer.provider, quotedGross, fees.policy);
    quotedBnb = Number(ethers.formatEther(quotedGross - quoteFee.feeWei));
  }
  const result = await execute(signer, calls, fees, false, 0n, telegramId, antiMev, gasMode);
  return { ...result, percentSold: percent, tokensSold: Number(ethers.formatUnits(amount, decimals)), tokenSymbol, quotedBnb,
    router: kind === 'curve' ? 'Flap.sh Bonding Curve' : `PancakeSwap ${kind.toUpperCase()}` };
}
export const buyV2 = (...args) => buyAtomicRoute('v2', ...args);
export const buyV3 = (...args) => buyAtomicRoute('v3', ...args);
export const buyCurve = (...args) => buyAtomicRoute('curve', ...args);
export const sellV2 = (...args) => sellAtomicRoute('v2', ...args);
export const sellV3 = (...args) => sellAtomicRoute('v3', ...args);
export const sellCurve = (...args) => sellAtomicRoute('curve', ...args);
