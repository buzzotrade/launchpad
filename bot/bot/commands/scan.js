import { scanToken } from '../lib/goplus.js';
import { assessRisk } from '../lib/ai.js';
import { showTokenPanel } from './buysell.js';
import { getPairData } from '../lib/tokens.js';
import { fetchPlatformToken } from '../lib/platform.js';

const BOT_LINK   = 'https://t.me/Buzzotrade_bot';
const BOT_HANDLE = 'https://t.me/Buzzotrade_bot';

async function fetchFlapCoin(ca) {
  try {
    const token = await fetchPlatformToken(ca);
    if (!token) return null;
    return { name: token.name, symbol: token.symbol, priceUsd: token.priceUsd,
      marketCapUsd: token.mcap, liquidityUsd: token.liquidity, nHolders: token.holders,
      metadata: { image: token.image, website: token.website, twitter: token.twitter, telegram: token.telegram } };
  } catch { return null; }
}

async function fetchBnbUsdPrice() {
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/tokens/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.pairs?.find(p => p.quoteToken?.symbol === 'USDT' || p.quoteToken?.symbol === 'BUSD') || data.pairs?.[0];
    return p ? parseFloat(p.priceUsd) : null;
  } catch { return null; }
}


async function fetchATH(pairAddress) {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pairAddress}/ohlcv/day?aggregate=1&limit=365`,
      { headers: { Accept: 'application/json;version=20230302' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const candles = data?.data?.attributes?.ohlcv_list;
    if (!candles?.length) return null;
    // Each candle: [timestamp, open, high, low, close, volume]
    const ath = Math.max(...candles.map(c => c[2]));
    return ath > 0 ? ath : null;
  } catch { return null; }
}

async function checkGraduated(ca) {
  try {
    const token = await fetchPlatformToken(ca);
    return token ? { graduated: token.graduated, graduatedAt: token.graduatedAt } : { graduated: false };
  } catch { return { graduated: false }; }
}


const BNB_RPC  = 'https://bsc-dataseed.binance.org/';
const DEAD_ADDR = '0x000000000000000000000000000000000000dead';

function rpcCall(to, data, id = 1) {
  return fetch(BNB_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id }),
  }).then(r => r.json()).then(d => d.result || '0x0');
}

function padAddr(addr) {
  return '000000000000000000000000' + addr.replace(/^0x/i, '').toLowerCase();
}

async function fetchSupplyData(ca) {
  try {
    // Read totalSupply, decimals, balanceOf(dead), balanceOf(contract) directly on-chain
    const [supplyHex, decimalsHex, burnHex, lockHex] = await Promise.all([
      rpcCall(ca, '0x18160ddd', 1),                       // totalSupply()
      rpcCall(ca, '0x313ce567', 2),                       // decimals()
      rpcCall(ca, '0x70a08231' + padAddr(DEAD_ADDR), 3),  // balanceOf(dead)
      rpcCall(ca, '0x70a08231' + padAddr(ca), 4),         // balanceOf(contract self)
    ]);

    const decimals = parseInt(decimalsHex, 16) || 18;
    const div = BigInt('1' + '0'.repeat(Math.min(decimals, 18)));

    function hexToTokens(hex) {
      if (!hex || hex === '0x' || hex === '0x0') return 0;
      const raw   = BigInt(hex);
      const whole = raw / div;
      const frac  = raw % div;
      return Number(whole) + Number(frac) / Number(div);
    }

    const total  = hexToTokens(supplyHex);
    const burned = hexToTokens(burnHex);
    const locked = hexToTokens(lockHex);
    const circ   = total > 0 ? Math.max(0, total - burned - locked) : null;

    return { total: total || null, burned, locked, circ };
  } catch (e) {
    console.warn('[supply]', e.message);
    return null;
  }
}

function fmtUsd(n) {
  if (!n && n !== 0) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n.toFixed(0)}`;
}

function fmtAge(ms) {
  if (!ms) return null;
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function fmtPrice(p) {
  if (p == null) return '?';
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.01) return p.toPrecision(4);
  return p.toFixed(4);
}

function fmtPct(n, showPlus = true) {
  if (n == null) return '?';
  return `${showPlus && n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function riskDot(scan, ch24h) {
  if (!scan) return '⚪';
  if (scan.isHoneypot || scan.cannotSell) return '🔴';
  if (scan.isMintable || scan.isBlacklisted || (scan.buyTax > 10) || (scan.sellTax > 10)) return '🟡';
  if (ch24h != null && ch24h < -20) return '🟠';
  return '🟢';
}

function isValidBotUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

function scanButtons(ca, dexLink, defLink, tg, web, tw) {
  const row2 = [
    { text: 'DEX', url: dexLink },
    { text: 'DEF', url: defLink },
  ];
  if (tg?.url  && isValidBotUrl(tg.url))  row2.push({ text: '💬', url: tg.url });
  if (web?.url && isValidBotUrl(web.url)) row2.push({ text: '🌍', url: web.url });
  if (tw?.url  && isValidBotUrl(tw.url))  row2.push({ text: '🐦', url: tw.url });
  return {
    inline_keyboard: [
      [
        { text: '❌', callback_data: `scan_del` },
        { text: '🔄', callback_data: `scan_ref_${ca}` },
        { text: '🔍', url: `https://bscscan.com/token/${ca}` },
        { text: '📊', url: `https://flap.sh/bnb/${ca}` },
        { text: '💰', callback_data: `scan_buy_${ca}` },
      ],
      row2,
    ],
  };
}

export async function buildScanText(ca, scan, pair, extra = {}) {
  const fc  = extra.flapCoin  || null;
  const bnb = extra.bnbPrice  || null;

  const fcMcapBnb = fc?.marketcap ? parseFloat(fc.marketcap) : null;
  const fcResBnb  = fc?.reserve   ? parseFloat(fc.reserve)   : null;
  const fcSupply  = fc?.supply    ? parseFloat(fc.supply)     : null;
  const fcTaxPct  = fc?.tax       ? parseFloat(fc.tax) * 100  : null;
  const fcMcapUsd = fc?.marketCapUsd ?? ((fcMcapBnb && bnb) ? fcMcapBnb * bnb : null);
  const fcLiqUsd  = fc?.liquidityUsd ?? ((fcResBnb && bnb) ? fcResBnb * bnb : null);
  const fcPrice   = fc?.priceUsd ?? ((fcMcapUsd && fcSupply && fcSupply > 0) ? fcMcapUsd / fcSupply : null);
  const fcBanner  = fc?.metadata?.image ? (/^https?:\/\//.test(fc.metadata.image)
    ? fc.metadata.image : `https://cloudflare-ipfs.com/ipfs/${fc.metadata.image.replace(/^ipfs:\/\//, '')}`) : null;

  const name    = pair?.baseToken?.name   || scan?.name   || fc?.name   || 'Unknown';
  const symbol  = pair?.baseToken?.symbol || scan?.symbol || fc?.symbol || '?';
  const price   = pair?.priceUsd ? parseFloat(pair.priceUsd) : fcPrice;
  const mcap    = pair?.marketCap  || pair?.fdv || fcMcapUsd || null;
  const fdv     = pair?.fdv        || null;
  const liq     = pair?.liquidity?.usd || fcLiqUsd || null;
  const vol24h  = pair?.volume?.h24    || null;
  const vol1h   = pair?.volume?.h1     || null;
  const buys24h = pair?.txns?.h24?.buys  ?? null;
  const sells24h= pair?.txns?.h24?.sells ?? null;
  const buys1h  = pair?.txns?.h1?.buys   ?? null;
  const sells1h = pair?.txns?.h1?.sells  ?? null;
  const txns1h  = (buys1h ?? 0) + (sells1h ?? 0);
  const ch1h    = pair?.priceChange?.h1  != null ? parseFloat(pair.priceChange.h1)  : null;
  const ch6h    = pair?.priceChange?.h6  != null ? parseFloat(pair.priceChange.h6)  : null;
  const ch24h   = pair?.priceChange?.h24 != null ? parseFloat(pair.priceChange.h24) : null;
  const dexId   = pair?.dexId || 'pancakeswap';
  const dexName = !pair && fc ? 'Flap.sh Bonding'
    : pair?._pairName ? pair._pairName
    : (dexId === 'pancakeswap' ? 'PancakeSwap' : dexId.charAt(0).toUpperCase() + dexId.slice(1));
  const pairAge = pair?.pairCreatedAt    || null;
  const pairAddr= pair?.pairAddress      || ca;

  const liqMult = (mcap && liq && liq > 0) ? Math.round(mcap / liq) : null;
  const liqHot  = liqMult && liqMult >= 8 ? '🔥' : '';

  // Top holders from GoPlus — each linked to bscscan
  let topHoldersLine = null;
  if (scan?.raw?.holders?.length) {
    const top5 = scan.raw.holders.slice(0, 5);
    const parts = top5.map(h => {
      const pct = (parseFloat(h.percent || 0) * 100).toFixed(1);
      return `<a href="https://bscscan.com/address/${h.address}">${pct}</a>`;
    });
    const total = top5.reduce((s, h) => s + parseFloat(h.percent || 0) * 100, 0);
    topHoldersLine = `👥 TH: ${parts.join('⋅')} [${total.toFixed(0)}%]`;
  }

  // Socials — DexScreener first, fallback to flap.sh metadata
  const socials  = pair?.info?.socials  || [];
  const websites = pair?.info?.websites || [];
  const tg  = socials.find(s => s.type === 'telegram')
    || (fc?.metadata?.telegram ? { type: 'telegram', url: fc.metadata.telegram } : null);
  const tw  = socials.find(s => s.type === 'twitter')
    || (fc?.metadata?.twitter  ? { type: 'twitter',  url: fc.metadata.twitter  } : null);
  const web = websites.find(w => w.label?.toLowerCase() === 'website') || websites[0]
    || (fc?.metadata?.website  ? { url: fc.metadata.website } : null);
  const banner = pair?.info?.header || fcBanner || null;

  // Security — fix NaN% by falling back to flap.sh tax for bonding tokens
  const hasGoPlus  = !!scan;
  const rawBuy  = scan?.buyTax;
  const rawSell = scan?.sellTax;
  const buyTaxStr  = (rawBuy  != null && !isNaN(rawBuy))  ? rawBuy.toFixed(0)  : (fcTaxPct != null ? fcTaxPct.toFixed(0)  : '?');
  const sellTaxStr = (rawSell != null && !isNaN(rawSell)) ? rawSell.toFixed(0) : (fcTaxPct != null ? fcTaxPct.toFixed(0) : '?');
  function hpRating(s) {
    if (!s) return null;
    if (s.isHoneypot)  return '🔴 HONEYPOT';
    if (s.cannotSell)  return '🔴 CANT SELL';
    const buyT  = s.buyTax  ?? 0;
    const sellT = s.sellTax ?? 0;
    const maxT  = Math.max(buyT, sellT);
    if (maxT > 50)                                           return '🔴 DANGER';
    if (s.isMintable || s.isBlacklisted || maxT > 10)       return '🟠 RISKY';
    if (s.tradingCooldown || s.isProxy || maxT > 5)         return '🟡 CAUTION';
    return '🟢 SAFE';
  }
  const hpStatus = hpRating(scan);

  const dot = riskDot(scan, ch24h);

  // Links
  const dexLink    = `https://dexscreener.com/bsc/${pairAddr}`;
  const defLink    = `https://www.defined.fi/bsc/${ca}`;
  const photonLink = `https://photon-bnb.tinyastro.io/en/r/@Buzzotrade_bot/${ca}`;
  const axiomLink  = `https://axiom.trade/t/${ca}/@buzzotrade?chain=bnb`;
  const gmgnLink   = `https://gmgn.ai/bsc/token/${ca}`;
  const bscscanLink= `https://bscscan.com/address/${ca}`;
  const ourBotLink = `${BOT_LINK}_${ca}`;

  const L = [];

  // Line 1 — risk dot + name linked to our bot + [mcap/change] + symbol
  const mcapStr = mcap ? fmtUsd(mcap) : '?';
  const ch24Str = (ch24h != null && isFinite(ch24h)) ? `${ch24h > 0 ? '+' : ''}${Number(ch24h).toFixed(0)}%` : '?';
  L.push(`${dot} <a href="${ourBotLink}">${name}</a> [${mcapStr}/${ch24Str}] <b>$${symbol}</b>`);

  // Line 2 — network/dex
  L.push(`🌐 BNB @ ${dexName}`);

  // Line 3 — price
  L.push(`💰 USD: ${fmtPrice(price)}`);

  // Line 4 — FDV
  if (fdv) L.push(`💎 FDV: ${fmtUsd(fdv)}`);

  // ATH
  const ath = extra.ath ?? null;
  if (ath != null && price != null) {
    const athPct = price > 0 ? ((price - ath) / ath * 100).toFixed(0) : null;
    const fromAth = athPct != null ? ` (${athPct}% from ATH)` : '';
    L.push(`📈 ATH: $${fmtPrice(ath)}${fromAth}`);
  }

  // Supply info
  const sup = extra.supply ?? null;
  if (sup?.total != null) {
    const circPart = sup.circ != null ? ` ⋅ Circ: ${fmtUsd(sup.circ)}` : '';
    L.push(`📦 Supply: ${fmtUsd(sup.total)}${circPart}`);
    const burnPart   = sup.burned > 0 ? `🔥 Burned: ${fmtUsd(sup.burned)}` : null;
    const lockedPart = sup.locked > 0 ? `🔒 Locked: ${fmtUsd(sup.locked)}` : null;
    const bl = [burnPart, lockedPart].filter(Boolean).join(' ⋅ ');
    if (bl) L.push(bl);
  }

  // Line 5 — liquidity
  L.push(`💦 Liq: ${liq ? fmtUsd(liq) : '?'}${liqMult ? ` [x${liqMult}]` : ''}${liqHot}`);

  // Line 6 — vol + age
  L.push(`📊 Vol: ${vol24h ? fmtUsd(vol24h) : '?'} ⋅ Age: ${fmtAge(pairAge) || '?'}`);

  // Line 7 — 1H activity
  const arrow1h = ch1h != null ? (ch1h >= 0 ? '📈' : '📉') : '📊';
  L.push(`${arrow1h} 1H: ${txns1h || '?'} ⋅ ${fmtPct(ch1h)} 🅑 ${buys1h ?? '?'} Ⓢ ${sells1h ?? '?'}`);

  // Line 8 — 6H/24H price changes
  if (ch6h != null || ch24h != null) {
    const c6  = ch6h  != null ? `6H: ${fmtPct(ch6h)}`  : null;
    const c24 = ch24h != null ? `24H: ${fmtPct(ch24h)}` : null;
    L.push(`📊 ${[c6, c24].filter(Boolean).join(' ⋅ ')}`);
  }

  L.push('');

  // Top holders
  if (topHoldersLine) L.push(topHoldersLine);

  // Total holders — GoPlus first, fallback to flap.sh nHolders
  const holderCount = scan?.holderCount || fc?.nHolders || null;
  if (holderCount) L.push(`🤝 Holders: ${Number(holderCount).toLocaleString()}`);

  // HP + Tax — show flap.sh bonding tax label if no GoPlus data
  if (hpStatus) {
    L.push(`🍯 ${hpStatus} ⋅ Tax: ${buyTaxStr}/${sellTaxStr}`);
  } else if (fcTaxPct != null) {
    L.push(`🪙 Bonding Tax: ${fcTaxPct.toFixed(0)}% ⋅ Security: 🟢 OK`);
  }

  // Graduation from Buzzo
  if (extra.graduated) {
    const gradDate = extra.graduatedAt
      ? new Date(Number(extra.graduatedAt)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : null;
    L.push(`🎓 Graduated from <a href="https://buzzo.trade">Buzzo</a>${gradDate ? ` · ${gradDate}` : ''}`);
  }

  L.push('');
  L.push(`<code>${ca}</code>`);
  L.push(`<a href="${ourBotLink}">Buzzo</a>`);

  L.push('');

  // AI analysis
  const ai = await assessRisk({
    name, symbol,
    price: price != null ? `$${fmtPrice(price)}` : '?',
    mcap: mcap ? `$${fmtUsd(mcap)}` : '?',
    liq: liq ? `$${fmtUsd(liq)}` : '?',
    vol24h: vol24h ? `$${fmtUsd(vol24h)}` : '?',
    buys: buys24h ?? '?', sells: sells24h ?? '?',
    buyTax: scan?.buyTax, sellTax: scan?.sellTax,
    isHoneypot: scan?.isHoneypot, isMintable: scan?.isMintable,
    lpLocked: scan?.lpLocked, lpLockedPercent: scan?.lpLockedPercent,
    holderCount: scan?.holderCount, isBlacklisted: scan?.isBlacklisted,
    tradingCooldown: scan?.tradingCooldown, cannotSell: scan?.cannotSell,
    ch1h, ch24h, hasGoPlus,
  }).catch(() => null);

  if (ai) L.push(`🕵️ ${ai}`);

  L.push('');
  L.push(`<i>Powered by <a href="${BOT_HANDLE}">@Buzzotrade_bot</a> · DYOR, NFA</i>`);

  return { text: L.join('\n'), banner, dexLink, defLink, tg, web, tw };
}

export async function doScan(ctx, ca) {
  const msg = await ctx.reply('🔍 Scanning token...');
  try {
    const [scan, pair] = await Promise.all([
      scanToken(ca),
      getPairData(ca),
    ]);

    // Official Buzzo launch metadata supplements missing DEX data.
    let flapCoin = null;
    let bnbPrice = null;
    if (!pair || !pair.priceUsd) {
      [flapCoin, bnbPrice] = await Promise.all([fetchFlapCoin(ca), fetchBnbUsdPrice()]);
    }

    if (!scan && !pair && !flapCoin) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        '❌ No data found for this token. It may be too new or not listed yet.'
      );
      return;
    }

    // Fetch ATH + graduation + supply in parallel (non-blocking — silently skip if unavailable)
    const pairAddr = pair?.pairAddress;
    const [athResult, gradResult, supplyResult] = await Promise.all([
      pairAddr ? fetchATH(pairAddr) : Promise.resolve(null),
      checkGraduated(ca),
      fetchSupplyData(ca),
    ]);

    const extra = {
      ath:         athResult,
      graduated:   gradResult?.graduated ?? false,
      graduatedAt: gradResult?.graduatedAt ?? null,
      supply:      supplyResult,
      flapCoin,
      bnbPrice,
    };

    const { text, banner, dexLink, defLink, tg, web, tw } = await buildScanText(ca, scan, pair, extra);
    const buttons = scanButtons(ca, dexLink, defLink, tg, web, tw);

    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});

    // Trim text to 1024 chars at a clean line boundary (Telegram caption limit)
    const caption = text.length <= 1024 ? text : (() => {
      let t = text.slice(0, 1021);
      const lastNl = t.lastIndexOf('\n');
      return (lastNl > 800 ? t.slice(0, lastNl) : t) + '…';
    })();

    const mediaOpts = { caption, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: buttons };

    if (banner) {
      // Detect format via magic bytes on raw URL (strips ?width=&quality= so GIFs stay animated)
      const rawBanner = banner.split('?')[0];
      let isGif = false;
      try {
        const peek = await fetch(rawBanner, { headers: { Range: 'bytes=0-5' } });
        const buf  = await peek.arrayBuffer();
        const b    = new Uint8Array(buf);
        isGif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
      } catch { /* default to photo */ }

      if (isGif) {
        await ctx.replyWithAnimation({ url: rawBanner }, mediaOpts).catch(() =>
          ctx.replyWithPhoto({ url: rawBanner }, mediaOpts).catch(() =>
            ctx.replyWithHTML(text, { disable_web_page_preview: true, reply_markup: buttons })
          )
        );
      } else {
        await ctx.replyWithPhoto({ url: banner }, mediaOpts).catch(() =>
          ctx.replyWithHTML(text, { disable_web_page_preview: true, reply_markup: buttons })
        );
      }
    } else {
      await ctx.replyWithHTML(text, { disable_web_page_preview: true, reply_markup: buttons });
    }

  } catch (e) {
    console.error('[/scan]', e.message);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null, `❌ Scan failed: ${e.message}`
    ).catch(() => ctx.reply(`❌ Scan failed: ${e.message}`));
  }
}

export async function handleScan(ctx) {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const ca = args[0];
  if (!ca || !ca.startsWith('0x') || ca.length !== 42) {
    return ctx.reply('Usage: /scan <contract_address>\nExample: /scan 0x1234...abcd');
  }
  return doScan(ctx, ca);
}
