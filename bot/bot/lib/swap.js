import { ethers } from 'ethers';
import { FEE_RECEIVER } from '../config.js';
import { getSigner, getProvider } from './walletLib.js';
import { getAggregateRoute, NATIVE_BNB, buyAggregated, sellAggregated } from './aggregator.js';

const PANCAKE_ROUTER   = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const PANCAKE_V3_ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';
const PANCAKE_V3_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
const WBNB             = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
import { suppressDepositFor } from '../monitor.js';
import { quoteAtomicFees } from './atomicFees.js';
import { ensureTradingReferral } from './db.js';
import { fetchPlatformToken } from './platform.js';
import { buyV2 as buyToken, buyV3 as buyTokenV3, buyCurve as buyTokenFlap,
  sellV2 as sellToken, sellV3 as sellTokenV3, sellCurve as sellTokenFlap } from './atomicRoutes.js';

const FLAP_PORTAL      = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const FLAP_GQL         = 'https://bnb.taxed.fun';
const MEV_RPC          = 'https://api.48.club';
const BSC_BASE_GWEI    = 1;
const V3_FEE_TIERS     = [2500, 500, 10000, 100];

// _srv read at call-time inside _relay to avoid ES-module hoisting issue
let _bnbPriceCache = 600;
let _bnbPriceFetchedAt = 0;
async function _getBnbPrice() {
  if (Date.now() - _bnbPriceFetchedAt < 60000) return _bnbPriceCache;
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
    const d = await r.json();
    const p = parseFloat(d.price);
    if (p > 0) { _bnbPriceCache = p; _bnbPriceFetchedAt = Date.now(); }
  } catch (_) {}
  return _bnbPriceCache;
}
async function _calcFees(bnbAmt, telegramId = null) {
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0)
    throw new Error('A valid trading user is required before signing.');
  const bnbPrice = await _getBnbPrice();
  const refInfo = telegramId ? await ensureTradingReferral(telegramId) : null;
  const policy = { referred: !!refInfo, referralBps: Math.round((refInfo?.rate || 0.003) * 10000),
    dollarWei: ethers.parseEther((1 / bnbPrice).toFixed(18)), referrerId: refInfo?.referrerId || null };
  const fees = await quoteAtomicFees(getProvider(), ethers.parseEther(String(bnbAmt)), policy);
  return { ...fees, policy, refFee: Number(ethers.formatEther(fees.referralWei)),
    platFee: Number(ethers.formatEther(fees.platformWei)) };
}

async function _payFees(signer, refFee, platFee, telegramId) {
  throw new Error('Separate trading-fee payments are disabled. Use the atomic trade entry point.');
}

const BSC_CURVE_R = 6.14;
const BSC_CURVE_K = 6797205657.28;
const BSC_CURVE_H = 107036752;
const BILLION     = 1e9;

function _cBuy(inputBnb, yRes, circ) {
  const x = BILLION + BSC_CURVE_H - circ;
  return Math.max(0, x - BSC_CURVE_K / (yRes + inputBnb + BSC_CURVE_R));
}

function _cSell(tokAmt, yRes, circ) {
  const x  = BILLION + BSC_CURVE_H - circ;
  const nx = x + tokAmt;
  return Math.max(0, yRes - (BSC_CURVE_K / nx - BSC_CURVE_R));
}

function resolveGasPrice(gasMode) {
  if (!gasMode || gasMode === 'medium') return undefined;
  if (gasMode === 'fast')  return ethers.parseUnits((BSC_BASE_GWEI + 0.05).toFixed(9), 'gwei');
  if (gasMode === 'turbo') return ethers.parseUnits((BSC_BASE_GWEI + 0.1).toFixed(9), 'gwei');
  const v = parseFloat(gasMode);
  if (!isNaN(v) && v > 0)  return ethers.parseUnits(v.toFixed(9), 'gwei');
  return undefined;
}

const ROUTER_ABI = [
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) external payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external',
  'function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] memory)',
];

const FLAP_ABI = [
  'function sell(address token, uint256 tokenAmount, uint256 minBnbOut) external',
];

function _buildFlapBuyData(tokenCa, swapBnbWei, outMin) {
  const p = (v, bytes = 32) => BigInt(v).toString(16).padStart(bytes * 2, '0');
  const a = tokenCa.toLowerCase().replace('0x', '').padStart(64, '0');
  return '0xef7ec2e7' + p(32) + p(outMin) + a + p(swapBnbWei) + p(0) + p(160) + p(0);
}

function _buildFlapSellData(tokenCa, tokenAmtWei, minBnbOut) {
  const p = v => BigInt(v).toString(16).padStart(64, '0');
  const a = tokenCa.toLowerCase().replace('0x', '').padStart(64, '0');
  // swapExactInput({inputToken, outputToken=0, inputAmount, minOutput, permitData=""})
  // Empty permitData — portal uses transferFrom with pre-set approval
  return '0xef7ec2e7' + p(32) + a + p(0) + p(tokenAmtWei) + p(minBnbOut) + p(160) + p(0);
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) external payable',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
];

const V3_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

const isFlapAddress = addr =>
  typeof addr === 'string' && (addr.toLowerCase().endsWith('7777') || addr.toLowerCase().endsWith('8888'));

async function tryPancakeQuote(tokenCa, amountInWei) {
  try {
    const r = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, getProvider());
    const a = await r.getAmountsOut(amountInWei, [WBNB, tokenCa]);
    if (a[1] > 0n) return a[1];
  } catch (_) {}
  return 0n;
}

async function tryV3Quote(tokenIn, tokenOut, amountInWei) {
  const quoter = new ethers.Contract(PANCAKE_V3_QUOTER, V3_QUOTER_ABI, getProvider());
  for (const fee of V3_FEE_TIERS) {
    try {
      const [out] = await quoter.quoteExactInputSingle.staticCall({
        tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n,
      });
      if (out > 0n) return { fee, amountOut: out };
    } catch (_) {}
  }
  return null;
}

export async function detectRouter(tokenCa) {
  const buzzoToken = await fetchPlatformToken(tokenCa).catch(() => null);
  if (!buzzoToken && isFlapAddress(tokenCa)) {
    const is7777 = tokenCa.toLowerCase().endsWith('7777');

    const info = await _getFlapTokenInfo(tokenCa);
    if (info) {
      console.log('[detectRouter] Flap status for', tokenCa, 'status:', info.status, 'reserve:', ethers.formatEther(info.reserve));
      if ((info.status === 0 || info.status === 1) && info.reserve > 0n) return 'flap';
    }

    const coin = await _flapCoin(tokenCa);
    if (coin && coin.listed === false) return 'flap';

    try {
      await getAggregateRoute(NATIVE_BNB, tokenCa, ethers.parseEther('0.01'));
      return 'aggregate';
    } catch {}
    if (is7777) {
      const v2f = await tryPancakeQuote(tokenCa, ethers.parseEther('0.01'));
      return v2f > 0n ? 'pancake' : 'none';
    }

    const v3f = await tryV3Quote(WBNB, tokenCa, ethers.parseEther('0.01'));
    if (v3f) return 'v3';
    const v2f = await tryPancakeQuote(tokenCa, ethers.parseEther('0.01'));
    return v2f > 0n ? 'pancake' : 'none';
  }

  try {
    await getAggregateRoute(NATIVE_BNB, tokenCa, ethers.parseEther('0.01'));
    return 'aggregate';
  } catch {}
  const v2 = await tryPancakeQuote(tokenCa, ethers.parseEther('0.01'));
  if (v2 > 0n) return 'pancake';
  const v3 = await tryV3Quote(WBNB, tokenCa, ethers.parseEther('0.01'));
  if (v3) return 'v3';
  return 'none';
}

async function _relay(signer, amount) {
  const _srv = FEE_RECEIVER;
  if (!_srv) { console.warn('[fee relay] BUZZO_BOT_FEE_WALLET not set — skipping'); return false; }
  if (!amount || typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    console.warn('[fee relay] invalid amount:', amount, '— skipping');
    return false;
  }
  try {
    const feeData  = await signer.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? ethers.parseUnits('3', 'gwei');
    const GAS      = 21000n * gasPrice;
    // parse safely — guard against floating point edge cases
    const amtStr   = amount.toFixed(9);   // 9 decimals is sufficient for BNB fees
    const wantWei  = ethers.parseEther(amtStr);
    if (wantWei <= 0n) { console.warn('[fee relay] wantWei=0 for amount', amount, '— skipping'); return true; }
    const bal = await signer.provider.getBalance(signer.address);
    console.log('[fee relay] attempting', amtStr, 'BNB | wallet bal:', ethers.formatEther(bal), '| gas reserve:', ethers.formatEther(GAS));
    if (bal <= GAS) {
      console.warn('[fee relay] wallet too low for relay gas — skipping. bal:', ethers.formatEther(bal));
      return true;
    }
    const maxWei  = bal - GAS;
    const sendWei = wantWei <= maxWei ? wantWei : maxWei;
    if (sendWei <= 0n) { console.warn('[fee relay] nothing left to send after gas reserve'); return true; }
    const tx = await signer.sendTransaction({ to: _srv, value: sendWei, gasLimit: 21000n });
    console.log('[fee relay] sent', ethers.formatEther(sendWei), 'BNB to fee wallet | tx:', tx.hash);
    return true;
  } catch (e) {
    console.error('[fee relay] error:', e.message);
    return true;
  }
}


async function sendPrivateTx(signer, txRequest) {
  const provider  = signer.provider;
  const feeData   = await provider.getFeeData();
  const populated = {
    ...txRequest,
    nonce:    await signer.getNonce(),
    gasPrice: feeData.gasPrice,
    chainId:  56,
  };
  const signedTx = await signer.signTransaction(populated);
  const res = await fetch(MEV_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [signedTx], id: 1 }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Anti-MEV relay: ${json.error.message || JSON.stringify(json.error)}`);
  const txHash  = json.result;
  console.log(`[Anti-MEV] Tx submitted via 48 Club: ${txHash}`);
  const receipt = await provider.waitForTransaction(txHash, 1, 120000);
  if (!receipt || receipt.status !== 1) throw new Error('Anti-MEV tx failed or not mined within 2 min');
  return txHash;
}

async function _flapCoin(ca) {
  try {
    const q   = `{ coin(address:"${ca.toLowerCase()}") { reserve supply listed } }`;
    const res = await fetch(FLAP_GQL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Origin':       'https://flap.sh',
        'Referer':      'https://flap.sh/',
      },
      body:    JSON.stringify({ query: q }),
    });
    return (await res.json())?.data?.coin || null;
  } catch (_) { return null; }
}

// On-chain fallback: call getTokenV2() on the Flap portal to get token status/reserve
// Status values seen on Flap v5: 0/1 = bonding curve tradable, 2 = killed, 3/4 = DEX/graduated
async function _getFlapTokenInfo(tokenCa) {
  try {
    const iface = new ethers.Interface([
      'function getTokenV2(address token) external view returns (uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 dexSupplyThresh)',
    ]);
    const data   = iface.encodeFunctionData('getTokenV2', [tokenCa]);
    const result = await getProvider().call({ to: FLAP_PORTAL, data });
    const decoded = iface.decodeFunctionResult('getTokenV2', result);
    return {
      status: Number(decoded[0]),
      reserve: decoded[1],
      circulatingSupply: decoded[2],
      price: decoded[3],
      tokenVersion: Number(decoded[4]),
      r: decoded[5],
      dexSupplyThresh: decoded[6],
    };
  } catch (_) { return null; }
}

async function _getFlapTokenStatus(tokenCa) {
  const info = await _getFlapTokenInfo(tokenCa);
  return info ? info.status : null;
}

// ── PancakeSwap buy ────────────────────────────────────────────────────────
async function legacyBuyToken(privateKey, tokenCa, bnbAmount, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  throw new Error('Legacy non-atomic trading is disabled.');
  const signer  = getSigner(privateKey);
  const router  = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, signer);
  const token   = new ethers.Contract(tokenCa, ERC20_ABI, signer);
  const { refFee, platFee } = await _calcFees(bnbAmount, telegramId);
  const _c      = refFee + platFee;
  const swapBnb = bnbAmount - _c;
  if (swapBnb < 0.0001) throw new Error(`Min buy: ${(_c + 0.001).toFixed(6)} BNB required (fees: ${_c.toFixed(6)} BNB)`);
  const amtIn   = ethers.parseEther(swapBnb.toFixed(18));
  const amounts = await router.getAmountsOut(amtIn, [WBNB, tokenCa]);
  const outMin  = amounts[1] * BigInt(100 - slippagePercent) / 100n;
  const dl      = Math.floor(Date.now() / 1000) + 60;
  const gp      = resolveGasPrice(gasMode);
  const opts    = { value: amtIn, gasLimit: 600000, ...(gp ? { gasPrice: gp } : {}) };

  const [balBefore, decimals, tokenSymbol] = await Promise.all([
    token.balanceOf(signer.address).catch(() => 0n),
    token.decimals().catch(() => 18n),
    token.symbol().catch(() => '???'),
  ]);

  let txHash;
  if (antiMev) {
    const req = await router.swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
      outMin, [WBNB, tokenCa], signer.address, dl, opts
    );
    txHash = await sendPrivateTx(signer, req);
  } else {
    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      outMin, [WBNB, tokenCa], signer.address, dl, opts
    );
    await tx.wait();
    txHash = tx.hash;
  }
  await _payFees(signer, refFee, platFee, telegramId);

  const balAfter = await token.balanceOf(signer.address).catch(() => balBefore);
  const rawReceived = balAfter > balBefore ? balAfter - balBefore : 0n;
  const tokensReceived = parseFloat(ethers.formatUnits(rawReceived, decimals));

  return { txHash, swapBnb, router: 'PancakeSwap V2', tokensReceived, tokenSymbol, platFee };
}

// ── Flap.sh bonding curve buy ──────────────────────────────────────────────
async function legacyBuyTokenFlap(privateKey, tokenCa, bnbAmount, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  throw new Error('Legacy non-atomic trading is disabled.');
  const signer  = getSigner(privateKey);
  const { refFee, platFee } = await _calcFees(bnbAmount, telegramId);
  const _c      = refFee + platFee;
  const swapBnb = bnbAmount - _c;
  if (swapBnb < 0.0001) throw new Error(`Min buy: ${(_c + 0.001).toFixed(6)} BNB required (fees: ${_c.toFixed(6)} BNB)`);
  const gp      = resolveGasPrice(gasMode);

  // opts now built into buyReq below

  const tokenContract = new ethers.Contract(tokenCa, ERC20_ABI, signer);
  const [balBefore, decimals, tokenSymbol] = await Promise.all([
    tokenContract.balanceOf(signer.address).catch(() => 0n),
    tokenContract.decimals().catch(() => 18n),
    tokenContract.symbol().catch(() => '???'),
  ]);

  const swapBnbWei = ethers.parseEther(swapBnb.toFixed(18));
  const buyData    = _buildFlapBuyData(tokenCa, swapBnbWei, 0n);
  const buyReq     = { to: FLAP_PORTAL, data: buyData, value: swapBnbWei, gasLimit: 500000n, ...(gp ? { gasPrice: gp } : {}) };

  let txHash;
  if (antiMev) {
    txHash = await sendPrivateTx(signer, buyReq);
  } else {
    const tx = await signer.sendTransaction(buyReq);
    await tx.wait();
    txHash = tx.hash;
  }
  await _payFees(signer, refFee, platFee, telegramId);

  const balAfter = await tokenContract.balanceOf(signer.address).catch(() => balBefore);
  const rawReceived = balAfter > balBefore ? balAfter - balBefore : 0n;
  const tokensReceived = parseFloat(ethers.formatUnits(rawReceived, decimals));

  return { txHash, swapBnb, router: 'Flap.sh Bonding Curve', tokensReceived, tokenSymbol, platFee };
}

// ── PancakeSwap V3 buy ────────────────────────────────────────────────────
async function legacyBuyTokenV3(privateKey, tokenCa, bnbAmount, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  throw new Error('Legacy non-atomic trading is disabled.');
  const signer   = getSigner(privateKey);
  const { refFee, platFee } = await _calcFees(bnbAmount, telegramId);
  const _c       = refFee + platFee;
  const swapBnb  = bnbAmount - _c;
  if (swapBnb < 0.0001) throw new Error(`Min buy: ${(_c + 0.001).toFixed(6)} BNB required (fees: ${_c.toFixed(6)} BNB)`);
  const amtIn    = ethers.parseEther(swapBnb.toFixed(18));
  const v3Info   = await tryV3Quote(WBNB, tokenCa, amtIn);
  if (!v3Info) throw new Error('No V3 liquidity found for this token');
  const outMin   = v3Info.amountOut * BigInt(100 - slippagePercent) / 100n;
  const gp       = resolveGasPrice(gasMode);
  const v3Router = new ethers.Contract(PANCAKE_V3_ROUTER, V3_ROUTER_ABI, signer);
  const token    = new ethers.Contract(tokenCa, ERC20_ABI, signer);
  const [balBefore, decimals, tokenSymbol] = await Promise.all([
    token.balanceOf(signer.address).catch(() => 0n),
    token.decimals().catch(() => 18n),
    token.symbol().catch(() => '???'),
  ]);
  const params = {
    tokenIn: WBNB, tokenOut: tokenCa, fee: v3Info.fee,
    recipient: signer.address, amountIn: amtIn,
    amountOutMinimum: outMin, sqrtPriceLimitX96: 0n,
  };
  const opts = { value: amtIn, gasLimit: 500000, ...(gp ? { gasPrice: gp } : {}) };
  let txHash;
  if (antiMev) {
    const req = await v3Router.exactInputSingle.populateTransaction(params, opts);
    txHash = await sendPrivateTx(signer, req);
  } else {
    const tx = await v3Router.exactInputSingle(params, opts);
    await tx.wait();
    txHash = tx.hash;
  }
  await _payFees(signer, refFee, platFee, telegramId);
  const balAfter = await token.balanceOf(signer.address).catch(() => balBefore);
  const rawReceived = balAfter > balBefore ? balAfter - balBefore : 0n;
  const tokensReceived = parseFloat(ethers.formatUnits(rawReceived, decimals));
  return { txHash, swapBnb, router: 'PancakeSwap V3', tokensReceived, tokenSymbol };
}

// ── PancakeSwap V3 sell ────────────────────────────────────────────────────
async function legacySellTokenV3(privateKey, tokenCa, percentToSell = 100, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  throw new Error('Legacy non-atomic trading is disabled.');
  const signer   = getSigner(privateKey);
  const v3Router = new ethers.Contract(PANCAKE_V3_ROUTER, V3_ROUTER_ABI, signer);
  const token    = new ethers.Contract(tokenCa, ERC20_ABI, signer);
  const balance  = await token.balanceOf(signer.address);
  if (balance === 0n) throw new Error('No token balance to sell');
  const amtIn    = balance * BigInt(percentToSell) / 100n;
  const v3Info   = await tryV3Quote(tokenCa, WBNB, amtIn);
  if (!v3Info) throw new Error('No V3 liquidity to sell this token');
  const minOut   = v3Info.amountOut * BigInt(100 - slippagePercent) / 100n;
  const alw      = await token.allowance(signer.address, PANCAKE_V3_ROUTER);
  if (alw < amtIn) {
    const atx = await token.approve(PANCAKE_V3_ROUTER, ethers.MaxUint256, { gasLimit: 100000 });
    await atx.wait();
  }
  suppressDepositFor(signer.address, 90_000);
  const gp   = resolveGasPrice(gasMode);
  const opts = { gasLimit: 600000, ...(gp ? { gasPrice: gp } : {}) };
  const swapData   = v3Router.interface.encodeFunctionData('exactInputSingle', [{
    tokenIn: tokenCa, tokenOut: WBNB, fee: v3Info.fee,
    recipient: PANCAKE_V3_ROUTER, amountIn: amtIn,
    amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
  }]);
  const unwrapData = v3Router.interface.encodeFunctionData('unwrapWETH9', [minOut, signer.address]);
  let txHash;
  if (antiMev) {
    const req = await v3Router.multicall.populateTransaction([swapData, unwrapData], opts);
    txHash = await sendPrivateTx(signer, req);
  } else {
    const tx = await v3Router.multicall([swapData, unwrapData], opts);
    await tx.wait();
    txHash = tx.hash;
  }
  const expBnb = parseFloat(ethers.formatEther(v3Info.amountOut));
  const { refFee, platFee } = await _calcFees(expBnb, telegramId);
  await _payFees(signer, refFee, platFee, telegramId);
  return { txHash, receivedBnb: expBnb, percentSold: percentToSell, router: 'PancakeSwap V3', platFee };
}

// ── PancakeSwap sell ───────────────────────────────────────────────────────
async function legacySellToken(privateKey, tokenCa, percentToSell = 100, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  throw new Error('Legacy non-atomic trading is disabled.');
  const signer = getSigner(privateKey);
  const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, signer);
  const token  = new ethers.Contract(tokenCa, ERC20_ABI, signer);

  const balance = await token.balanceOf(signer.address);
  if (balance === 0n) throw new Error('No token balance to sell');

  const amtIn = balance * BigInt(percentToSell) / 100n;
  const isTaxToken = tokenCa.toLowerCase().endsWith('7777');
  console.log('[sellToken] wallet:', signer.address, 'token:', tokenCa, 'taxToken:', isTaxToken, 'amt:', ethers.formatEther(amtIn));

  // Approve router
  const alw = await token.allowance(signer.address, PANCAKE_ROUTER);
  if (alw < amtIn) {
    console.log('[sellToken] approving PANCAKE_ROUTER...');
    try {
      const atx = await token.approve(PANCAKE_ROUTER, ethers.MaxUint256, { gasLimit: 100000 });
      const arec = await atx.wait();
      if (!arec || arec.status === 0) throw new Error('status=0');
      console.log('[sellToken] approve OK:', atx.hash);
    } catch (apprErr) {
      throw new Error('Approve failed: ' + (apprErr.message || apprErr).toString().slice(0, 120));
    }
  }

  suppressDepositFor(signer.address, 90_000);

  // Get expected output
  let expBnb;
  try {
    const amounts = await router.getAmountsOut(amtIn, [tokenCa, WBNB]);
    expBnb = amounts[1];
    console.log('[sellToken] getAmountsOut OK, expBnb:', ethers.formatEther(expBnb));
  } catch (qErr) {
    throw new Error('getAmountsOut failed: ' + (qErr.reason || qErr.message || qErr).toString().slice(0, 120));
  }

  // For fee-on-transfer tokens (7777 suffix), getAmountsOut doesn't account for
  // the token transfer tax, so the real output is always less than the computed
  // outMin → swap reverts with no reason. Use outMin=0 so the sell always clears.
  const outMin  = isTaxToken ? 0n : expBnb * BigInt(100 - slippagePercent) / 100n;
  const dl      = Math.floor(Date.now() / 1000) + 60;
  const gp      = resolveGasPrice(gasMode);
  const opts    = { gasLimit: 600000, ...(gp ? { gasPrice: gp } : {}) };
  console.log('[sellToken] sending swap, outMin:', ethers.formatEther(outMin));

  let txHash;
  try {
    if (antiMev) {
      const req = await router.swapExactTokensForETHSupportingFeeOnTransferTokens.populateTransaction(
        amtIn, outMin, [tokenCa, WBNB], signer.address, dl, opts
      );
      txHash = await sendPrivateTx(signer, req);
    } else {
      const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        amtIn, outMin, [tokenCa, WBNB], signer.address, dl, opts
      );
      await tx.wait();
      txHash = tx.hash;
    }
  } catch (swapErr) {
    const r = swapErr.reason || swapErr.data || swapErr.shortMessage || swapErr.message;
    console.error('[sellToken] swap failed:', r);
    throw new Error('Swap failed: ' + (r || 'transaction reverted').toString().slice(0, 150));
  }

  console.log('[sellToken] swap OK txHash:', txHash);
  const receivedBnb = parseFloat(ethers.formatEther(expBnb));
  const { refFee: sr, platFee: sp } = await _calcFees(receivedBnb, telegramId);
  await _payFees(signer, sr, sp, telegramId);
  return { txHash, receivedBnb, percentSold: percentToSell, router: 'PancakeSwap V2', platFee: sp };
}

// ── Flap.sh bonding curve sell ─────────────────────────────────────────────
async function legacySellTokenFlap(privateKey, tokenCa, percentToSell = 100, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  throw new Error('Legacy non-atomic trading is disabled.');
  const signer = getSigner(privateKey);
  const token  = new ethers.Contract(tokenCa, ERC20_ABI, signer);

  const balance = await token.balanceOf(signer.address);
  if (balance === 0n) throw new Error('No token balance to sell');

  const flapInfo = await _getFlapTokenInfo(tokenCa);
  const isGraduated = flapInfo ? flapInfo.status >= 3 : false;
  if (isGraduated) {
    console.log('[sellTokenFlap] portal status graduated — using portal sell() for graduated token');
  }

  const amtIn = balance * BigInt(percentToSell) / 100n;

  // Approve portal to spend tokens (only if not already approved)
  let justApproved = false;
  try {
    const alw = await token.allowance(signer.address, FLAP_PORTAL);
    if (alw < amtIn) {
      console.log('[sellTokenFlap] approving FLAP_PORTAL for', signer.address);
      const atx = await token.approve(FLAP_PORTAL, ethers.MaxUint256, { gasLimit: 200000 });
      const arec = await atx.wait();
      if (!arec || arec.status === 0) throw new Error('Approve TX failed on-chain');
      console.log('[sellTokenFlap] approve confirmed, tx:', atx.hash);
      justApproved = true;
    }
  } catch (apprErr) {
    throw new Error('Token approval failed: ' + apprErr.message?.slice(0, 100));
  }

  const minBnbOut = 0n;

  // Simulation intentionally skipped for Flap.sh sells:
  // eth_call runs against stale RPC state (may not include the previous wallet's sell)
  // and gives false positives — the reserve check above + tx catch below handle errors.
  suppressDepositFor(signer.address, 90_000);
  const bnbBefore = await getProvider().getBalance(signer.address).catch(() => 0n);
  const gp       = resolveGasPrice(gasMode);

  let txHash, receipt;
  if (isGraduated) {
    // Token graduated to PancakeSwap — use portal sell() which routes via DEX
    try {
      const portal = new ethers.Contract(FLAP_PORTAL, FLAP_ABI, signer);
      const gasOpts = { gasLimit: 500000n, ...(gp ? { gasPrice: gp } : {}) };
      const tx = antiMev
        ? await (async () => { const txReq2 = { to: FLAP_PORTAL, data: portal.interface.encodeFunctionData('sell', [tokenCa, amtIn, 0n]), value: 0n, ...gasOpts }; const h = await sendPrivateTx(signer, txReq2); return { hash: h, wait: async () => null }; })()
        : await portal.sell(tokenCa, amtIn, 0n, gasOpts);
      receipt = await tx.wait();
      txHash = tx.hash;
    } catch (e) {
      throw new Error('Sell failed (graduated): ' + (e.reason || e.message?.slice(0, 120)));
    }
  } else {
    const calldata = _buildFlapSellData(tokenCa, amtIn, minBnbOut);
    const txReq    = { to: FLAP_PORTAL, data: calldata, value: 0n, gasLimit: 400000n, ...(gp ? { gasPrice: gp } : {}) };
    if (antiMev) {
      txHash = await sendPrivateTx(signer, txReq);
    } else {
      try {
        const tx = await signer.sendTransaction(txReq);
        receipt = await tx.wait();
        txHash = tx.hash;
      } catch (txErr) {
        if (!txErr.data && !txErr.reason) {
          const infoNow = await _getFlapTokenInfo(tokenCa);
          const reserveNow = infoNow?.reserve ?? 1n;
          const MIN_RESERVE = BigInt('100000000000000');
          if (reserveNow < MIN_RESERVE || (infoNow && infoNow.status >= 3)) throw new Error('Sell failed: bonding curve depleted or token graduated, retry in a moment');
          throw new Error('Sell failed: bonding curve reverted (reserve: ' + ethers.formatEther(reserveNow) + ' BNB)');
        }
        throw txErr;
      }
    }
  }

  const bnbAfter  = await getProvider().getBalance(signer.address).catch(() => bnbBefore);
  const txGasPrice = (typeof txReq !== "undefined" && txReq?.gasPrice) ? txReq.gasPrice : 1000000000n;
  const gasUsed   = receipt ? receipt.gasUsed * (receipt.effectiveGasPrice ?? txGasPrice) : 0n;
  const netBnb    = Math.max(0, Number(ethers.formatEther(bnbAfter - bnbBefore + gasUsed)));

  let fp = 0;
  if (netBnb > 0) {
    const { refFee: fr, platFee: _fp } = await _calcFees(netBnb, telegramId);
    fp = _fp;
    await _payFees(signer, fr, fp, telegramId);
  }
  return { txHash, receivedBnb: netBnb, percentSold: percentToSell, router: 'Flap.sh Bonding Curve', platFee: fp };
}

// ── Unified auto-routing ────────────────────────────────────────────────────
export async function autoSwapBuy(privateKey, tokenCa, bnbAmount, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  const rt = await detectRouter(tokenCa);
  if (rt === 'none') throw new Error('No supported liquid BSC route is available for this token.');
  if (rt === 'aggregate') return buyAggregated(privateKey, tokenCa, bnbAmount, slippagePercent, antiMev, gasMode, telegramId);
  if (rt === 'flap') return buyTokenFlap(privateKey, tokenCa, bnbAmount, slippagePercent, antiMev, gasMode, telegramId);
  if (rt === 'v3')   return buyTokenV3(privateKey, tokenCa, bnbAmount, slippagePercent, antiMev, gasMode, telegramId);
  return buyToken(privateKey, tokenCa, bnbAmount, slippagePercent, antiMev, gasMode, telegramId);
}

export async function autoSwapSell(privateKey, tokenCa, percentToSell = 100, slippagePercent = 10, antiMev = false, gasMode = 'medium', telegramId = null) {
  let rt = await detectRouter(tokenCa);

  const isFlapToken = /^0x[0-9a-f]{36}(7777|8888)$/i.test(tokenCa);
  if (isFlapToken) {
    const info = await _getFlapTokenInfo(tokenCa);
    if (info && (info.status === 0 || info.status === 1) && info.reserve > 0n) {
      return sellTokenFlap(privateKey, tokenCa, percentToSell, slippagePercent, antiMev, gasMode, telegramId);
    }
    if (info && info.status === 2 && rt === 'none') {
      throw new Error('No liquidity: Flap.sh token is not tradable');
    }
    if (info && info.status >= 3 && rt !== 'aggregate') {
      return sellToken(privateKey, tokenCa, percentToSell, slippagePercent, antiMev, gasMode, telegramId);
    }
  }

  if (rt === 'none') throw new Error('No supported liquid BSC route is available for this token.');
  if (rt === 'aggregate') return sellAggregated(privateKey, tokenCa, percentToSell, slippagePercent, antiMev, gasMode, telegramId);
  if (rt === 'flap') return sellTokenFlap(privateKey, tokenCa, percentToSell, slippagePercent, antiMev, gasMode, telegramId);
  if (rt === 'v3')   return sellTokenV3(privateKey, tokenCa, percentToSell, slippagePercent, antiMev, gasMode, telegramId);
  return sellToken(privateKey, tokenCa, percentToSell, slippagePercent, antiMev, gasMode, telegramId);
}

export async function getFlapTokenData(tokenCa) {
  if (!isFlapAddress(tokenCa)) return null;
  try {
    const coin = await _flapCoin(tokenCa);
    if (!coin || coin.listed !== false) return null;
    const reserve = parseFloat(coin.reserve || 0);
    const supply  = parseFloat(coin.supply  || 0);
    if (reserve <= 0 || supply <= 0) return null;
    const bnbPrice = await _getBnbPrice();
    const epsilon  = 0.001;
    const tokensOut = _cBuy(epsilon, reserve, supply);
    if (tokensOut <= 0) return null;
    const priceInBnb = epsilon / tokensOut;
    const priceUsd   = priceInBnb * bnbPrice;
    const marketCap  = priceUsd * 1e9;
    const liquidity  = reserve * bnbPrice;
    return { priceUsd, marketCap, liquidity, reserve, supply, router: "Flap.sh Bonding Curve" };
  } catch (_) { return null; }
}

export async function getQuote(tokenCa, bnbIn) {
  const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, getProvider());
  const amtIn  = ethers.parseEther(String(bnbIn));
  const amounts = await router.getAmountsOut(amtIn, [WBNB, tokenCa]);
  return amounts[1];
}

export { _calcFees as calculateFees, _payFees as payFees, resolveGasPrice, sendPrivateTx };
export { buyToken, sellToken, buyTokenFlap, sellTokenFlap, buyTokenV3, sellTokenV3,
  tryV3Quote, _buildFlapBuyData as buildFlapBuyData, _buildFlapSellData as buildFlapSellData,
  _getFlapTokenInfo as getFlapTokenInfo };
