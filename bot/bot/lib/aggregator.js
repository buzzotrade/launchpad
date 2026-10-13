import { ethers } from 'ethers';
import { getSigner } from './walletLib.js';
import { executeWalletTrade as executeAtomicTrade } from './walletTrading.js';
import { approvalCalls } from './atomicRoutes.js';

export const NATIVE_BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const AGGREGATOR_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const API = 'https://aggregator-api.kyberswap.com/bsc/api/v1';
// MetaAggregationRouterV2's verified swap signature (selector 0xe21fd0e9).
export const AGGREGATOR_ABI = new ethers.Interface([
  'function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256,uint256)',
]);
const same = (a, b) => ethers.isAddress(a) && ethers.isAddress(b) && a.toLowerCase() === b.toLowerCase();
async function request(path, body) {
  const response = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-client-id': 'buzzo-trade-bot', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0 || !result.data) throw new Error('BSC route unavailable; retry or use another liquid token.');
  return result.data;
}
export async function getAggregateRoute(tokenIn, tokenOut, amountIn) {
  const params = new URLSearchParams({ tokenIn, tokenOut, amountIn: String(amountIn), excludeRFQSources: 'true' });
  const result = await request(`routes?${params}`);
  const route = result.routeSummary;
  if (!same(result.routerAddress, AGGREGATOR_ROUTER) || !route ||
      !same(route.tokenIn, tokenIn) || !same(route.tokenOut, tokenOut) ||
      BigInt(route.amountIn) !== BigInt(amountIn) || BigInt(route.amountOut) <= 0n)
    throw new Error('BSC route validation failed.');
  return route;
}
export function validateAggregateBuild(build, route, wallet, slippage) {
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 100) throw new Error('Slippage must be below 100%.');
  if (!same(build.routerAddress, AGGREGATOR_ROUTER) || BigInt(build.amountIn) !== BigInt(route.amountIn))
    throw new Error('Unexpected swap router or input amount.');
  const decoded = AGGREGATOR_ABI.parseTransaction({ data: build.data });
  if (!decoded || decoded.name !== 'swap') throw new Error('Unrecognized swap calldata.');
  const desc = decoded.args.execution.desc;
  // The live builder rounds its refreshed output by one base unit. Permit only
  // that integer rounding difference, never an unbounded repricing of the quote.
  const minimum = BigInt(route.amountOut) * BigInt(10000 - Math.floor(slippage * 100)) / 10000n;
  const value = same(route.tokenIn, NATIVE_BNB) ? BigInt(route.amountIn) : 0n;
  if (!same(desc.srcToken, route.tokenIn) || !same(desc.dstToken, route.tokenOut) ||
      !same(desc.dstReceiver, wallet) || desc.amount !== BigInt(route.amountIn) ||
      desc.minReturnAmount <= 0n || desc.minReturnAmount + 1n < minimum ||
      desc.permit !== '0x' || desc.feeAmounts.some(fee => fee !== 0n) ||
      BigInt(build.transactionValue) !== value)
    throw new Error('Swap recipient, tokens, limits or fees failed validation.');
  return { to: AGGREGATOR_ROUTER, data: build.data, value };
}
export async function executeAggregateSwap(signer, route, slippage, antiMev, gasMode, context) {
  if (!context?.policy || !context.telegramId)
    throw new Error('Atomic swap context and fee policy required. No transaction was sent.');
  const { resolveGasPrice } = await import('./swap.js');
  const prepared = await prepareAggregateSwap(signer, route, slippage);
  const result = await executeAtomicTrade(signer, prepared.calls, context.policy, {
    buy: same(route.tokenIn, NATIVE_BNB), gross: context.gross || 0n,
    telegramId: context.telegramId, antiMev, gasPrice: resolveGasPrice(gasMode),
  });
  return { ...result, router: prepared.router };
}
export async function prepareAggregateSwap(signer, route, slippage) {
  const build = await request('route/build', {
    routeSummary: route, sender: signer.address, recipient: signer.address, origin: signer.address,
    slippageTolerance: Math.floor(slippage * 100), ignoreCappedSlippage: slippage > 20,
    deadline: Math.floor(Date.now() / 1000) + 120, source: 'buzzo-trade-bot', enableGasEstimation: false,
  });
  const transaction = validateAggregateBuild(build, route, signer.address, slippage);
  const calls = same(route.tokenIn, NATIVE_BNB) ? []
    : await approvalCalls(signer, route.tokenIn, AGGREGATOR_ROUTER, BigInt(route.amountIn));
  calls.push({ target: transaction.to, value: transaction.value, data: transaction.data });
  const sources = [...new Set(route.route?.flat().map(pool => pool.exchange) || [])];
  return { calls, router: `BSC • ${sources.join(' + ') || 'aggregated DEX route'}` };
}
export async function buyAggregated(privateKey, tokenCa, amount, slippage, antiMev, gasMode, telegramId) {
  const { calculateFees, resolveGasPrice } = await import('./swap.js');
  const fees = await calculateFees(amount, telegramId);
  const gross = ethers.parseEther(String(amount));
  const input = gross - fees.feeWei;
  const swapBnb = Number(ethers.formatEther(input));
  if (!Number.isFinite(swapBnb) || swapBnb < 0.0001) throw new Error('Buy amount is too small after fees.');
  const route = await getAggregateRoute(NATIVE_BNB, tokenCa, input);
  const signer = getSigner(privateKey);
  const token = new ethers.Contract(tokenCa, ['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)'], signer);
  const [before, decimals, tokenSymbol] = await Promise.all([token.balanceOf(signer.address), token.decimals(), token.symbol().catch(() => '???')]);
  const prepared = await prepareAggregateSwap(signer, route, slippage);
  const result = await executeAtomicTrade(signer, prepared.calls, fees.policy, {
    buy: true, gross, telegramId, antiMev, gasPrice: resolveGasPrice(gasMode),
  });
  let tokensReceived = null;
  try {
    const after = await token.balanceOf(signer.address, { blockTag: result.blockNumber });
    tokensReceived = Number(ethers.formatUnits(after > before ? after - before : 0n, decimals));
  } catch { /* The on-chain receipt stays successful even if this optional read fails. */ }
  return { ...result, router: prepared.router, swapBnb, tokenSymbol, tokensReceived,
    quotedTokens: Number(ethers.formatUnits(BigInt(route.amountOut), decimals)) };
}
export async function sellAggregated(privateKey, tokenCa, percent, slippage, antiMev, gasMode, telegramId) {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('Sell percentage must be 1–100.');
  const signer = getSigner(privateKey);
  const token = new ethers.Contract(tokenCa, ['function balanceOf(address) view returns(uint256)'], signer);
  const amount = (await token.balanceOf(signer.address)) * BigInt(Math.floor(percent * 100)) / 10000n;
  if (amount <= 0n) throw new Error('No token balance to sell.');
  const route = await getAggregateRoute(tokenCa, NATIVE_BNB, amount);
  const { calculateFees, resolveGasPrice } = await import('./swap.js');
  const fees = await calculateFees(0.01, telegramId);
  const info = new ethers.Contract(tokenCa, ['function decimals() view returns(uint8)', 'function symbol() view returns(string)'], signer.provider);
  const [decimals, tokenSymbol] = await Promise.all([info.decimals(), info.symbol()]);
  const prepared = await prepareAggregateSwap(signer, route, slippage);
  const result = await executeAtomicTrade(signer, prepared.calls, fees.policy, {
    buy: false, telegramId, antiMev, gasPrice: resolveGasPrice(gasMode),
  });
  return { ...result, router: prepared.router, percentSold: percent, tokenSymbol,
    tokensSold: Number(ethers.formatUnits(amount, decimals)),
    quotedBnb: Number(ethers.formatEther(BigInt(route.amountOut))) };
}
