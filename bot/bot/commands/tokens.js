const SITE_URL = 'https://buzzo.trade';
import { fetchPlatformTokens, fetchPlatformToken } from '../lib/platform.js';

async function _fetchHoneypotPair(ca) {
  try {
    const r = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${ca}&chainID=56`,
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();
    const addr = d?.pair?.pair?.address || null;
    const name = d?.pair?.pair?.name   || null;
    return addr ? { address: addr, name } : null;
  } catch { return null; }
}

async function _fetchGeckoPool(pairAddr) {
  try {
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pairAddr}`,
      { headers: { Accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const attrs = d?.data?.attributes;
    if (!attrs) return null;
    const price = attrs.base_token_price_usd ? Number(attrs.base_token_price_usd) : null;
    const liq   = attrs.reserve_in_usd       ? Number(attrs.reserve_in_usd)       : null;
    const fdv   = attrs.fdv_usd              ? Number(attrs.fdv_usd)              : null;
    const mcap  = attrs.market_cap_usd       ? Number(attrs.market_cap_usd)       : fdv;
    if (!price && !liq) return null;
    return {
      priceUsd:    price ? String(price) : null,
      marketCap:   mcap,
      fdv,
      liquidity:   { usd: liq },
      volume:      { h24: attrs.volume_usd?.h24 ? Number(attrs.volume_usd.h24) : null },
      priceChange: {
        h24: attrs.price_change_percentage?.h24 ?? null,
        h6:  attrs.price_change_percentage?.h6  ?? null,
        h1:  attrs.price_change_percentage?.h1  ?? null,
      },
      pairAddress: pairAddr,
      _fromGecko: true,
    };
  } catch { return null; }
}

async function _fetchMoralis(ca) {
  try {
    const apiKey = process.env.MORALIS_API_KEY;
    if (!apiKey) return null;
    const r = await fetch(
      `https://deep-index.moralis.io/api/v2.2/erc20/${ca}/price?chain=bsc&include=percent_change`,
      { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.usdPrice) return null;
    return {
      priceUsd:    String(d.usdPrice),
      marketCap:   null,
      fdv:         null,
      liquidity:   { usd: null },
      volume:      { h24: null },
      priceChange: {
        h24: d['24hrPercentChange'] ? parseFloat(d['24hrPercentChange']) : null,
        h6:  null,
        h1:  null,
      },
      pairAddress: null,
      _fromMoralis: true,
    };
  } catch { return null; }
}

export async function getPairData(ca) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`,
      { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      const pair = (d.pairs || []).find(p => p.chainId === 'bsc') || d.pairs?.[0] || null;
      if (pair?.priceUsd || pair?.liquidity?.usd) return pair;
    }
  } catch { /* fall through */ }

  const hpPair = await _fetchHoneypotPair(ca);
  if (hpPair?.address) {
    const gecko = await _fetchGeckoPool(hpPair.address);
    if (gecko) {
      gecko._pairName = hpPair.name;
      return gecko;
    }
  }

  return _fetchMoralis(ca);
}

export async function getNewTokens(limit = 5) {
  return (await fetchPlatformTokens()).slice(0, limit);
}

export async function getTokenInfo(ca) {
  return fetchPlatformToken(ca);
}

export function formatMcap(n) {
  if (!n || n <= 0) return '?';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatTokenList(tokens) {
  if (!tokens.length) return 'No new tokens right now.';
  return tokens.map((t, i) => {
    const name = t.name || t.ticker || '?';
    const ticker = t.ticker ? `$${t.ticker.replace(/^\$/, '')}` : '';
    const mcap = formatMcap(t.mcap);
    const age = t.createdAt ? getAge(t.createdAt) : '';
    return `${i + 1}. *${name}* ${ticker}\n   MCap: ${mcap}${age ? ` · ${age}` : ''}\n   \`${t.address || t.ca || ''}\``;
  }).join('\n\n');
}

function getAge(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
