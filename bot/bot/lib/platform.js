import { SITE_URL } from '../config.js';

export function numberFromDisplay(value) {
  if (value == null || value === '' || value === '?') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/[$,\s]/g, '').match(/^(-?\d+(?:\.\d+)?)([KMB])?$/i);
  return match ? Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] || 1) : null;
}

export function normalizeToken(token) {
  return {
    ...token,
    address: token.contractAddress,
    createdAt: token.launchedAt,
    mcap: numberFromDisplay(token.mc),
    marketCap: numberFromDisplay(token.mc),
    priceUsd: numberFromDisplay(token.price),
    volume24h: numberFromDisplay(token.vol),
    pairAddr: token.poolAddress || null,
    graduated: Boolean(token.poolAddress && token.transactionHash),
    graduatedAt: token.poolAddress && token.transactionHash ? token.launchedAt : null,
    url: `${SITE_URL}/token/${encodeURIComponent(token.id)}`,
  };
}

let cachedTokens = null;
let cacheExpires = 0;
let inFlight = null;
export async function fetchPlatformTokens() {
  if (cachedTokens && Date.now() < cacheExpires) return cachedTokens;
  if (inFlight) return inFlight;
  inFlight = loadPlatformTokens();
  try {
    cachedTokens = await inFlight;
    cacheExpires = Date.now() + 30000;
    return cachedTokens;
  } finally { inFlight = null; }
}
async function loadPlatformTokens() {
  const response = await fetch(`${SITE_URL}/api/buzzo/tokens`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Buzzo token feed unavailable (${response.status})`);
  const tokens = await response.json();
  if (!Array.isArray(tokens)) throw new Error('Unexpected Buzzo token feed format');
  return tokens.filter(t => !t.demo && !t.seeded && (t.chainId == null || Number(t.chainId) === 56) &&
    t.transactionHash && t.poolAddress && /^0x[a-fA-F0-9]{40}$/.test(t.contractAddress || ''))
    .map(normalizeToken).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function fetchPlatformToken(ca) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) return null;
  return (await fetchPlatformTokens()).find(token => token.address.toLowerCase() === ca.toLowerCase()) || null;
}
