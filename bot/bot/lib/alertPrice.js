import { ethers } from 'ethers';
import { getProvider } from './walletLib.js';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const cache = new Map();
async function usdPrice(ca) {
  const cached = cache.get(ca.toLowerCase());
  if (cached && Date.now()-cached.ts < 15000) return cached.price;
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`,{signal:AbortSignal.timeout(7000)});
  if (!response.ok) throw new Error('Price feed unavailable');
  const data = await response.json();
  const pairs = (data.pairs||[]).filter(p=>p.chainId==='bsc')
    .sort((a,b)=>Number(b.liquidity?.usd||0)-Number(a.liquidity?.usd||0));
  const price = Number(pairs[0]?.priceUsd);
  if (!Number.isFinite(price)||price<=0) throw new Error('No liquid BSC price');
  if (cache.size>500) cache.clear();
  cache.set(ca.toLowerCase(),{price,ts:Date.now()});
  return price;
}
export function normalizeLegacyAlertPrice(entry,decimals) {
  const tokensPerBnb = Number(entry)*10**(18-Number(decimals));
  return tokensPerBnb>0 ? 1/tokensPerBnb : 0;
}
export function alertTargetReached(current,entry,multiplier) {
  if (![current,entry,multiplier].every(value=>Number.isFinite(value)&&value>0)) return false;
  return multiplier>=1 ? current>=entry*multiplier : current<=entry*multiplier;
}
export async function getAlertPrice(ca) {
  if (!ethers.isAddress(ca)) throw new Error('Invalid token address');
  if (ca.toLowerCase()===WBNB.toLowerCase()) return 1;
  try {
    const [tokenUsd,bnbUsd] = await Promise.all([usdPrice(ca),usdPrice(WBNB)]);
    return tokenUsd/bnbUsd;
  } catch {
    const provider = getProvider();
    const token = new ethers.Contract(ca,['function decimals() view returns (uint8)'],provider);
    const router = new ethers.Contract(ROUTER,['function getAmountsOut(uint,address[]) view returns (uint[])'],provider);
    const [decimals,amounts] = await Promise.all([token.decimals(),router.getAmountsOut(ethers.parseEther('1'),[WBNB,ca])]);
    const tokensPerBnb = Number(ethers.formatUnits(amounts[1],decimals));
    if (!Number.isFinite(tokensPerBnb)||tokensPerBnb<=0) throw new Error('Price unavailable');
    return 1/tokensPerBnb;
  }
}
