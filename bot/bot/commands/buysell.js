import { getBnbBalance, getTokenBalance, getActiveWalletData, getManualWalletData, getManualWalletByIdData } from '../lib/walletLib.js';
import { autoSwapBuy, autoSwapSell } from '../lib/swap.js';
import { resolveSlippage } from '../lib/slippage.js';
import { saveTrade, getUser, getAvgBuyPrice, getCustomBuys, getCustomSells, getUserWallets } from '../lib/db.js';
import { scanToken } from '../lib/goplus.js';
import { limitMenu } from './limit.js';
import { buySuccessMsg, buyFailMsg, sellSuccessMsg, sellFailMsg } from '../lib/notify.js';
import { getPairData } from '../lib/tokens.js';
import { walletLabel } from '../lib/walletLabel.js';
const escHtml = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

export const GAS_MODES = {
  medium: { label: '🐢 Medium', extra: 0    },
  fast:   { label: '🐴 Fast',   extra: 0.05 },
  turbo:  { label: '🐋 Turbo',  extra: 0.1  },
};

export function gasLabel(gasMode) {
  if (!gasMode || gasMode === 'medium') return '⛽ Gas 🐢 Medium';
  if (gasMode === 'fast')  return '⛽ Gas 🐴 Fast';
  if (gasMode === 'turbo') return '⛽ Gas 🐋 Turbo';
  return `⛽ Gas ${gasMode} GWEI`;
}

export function gasPanel(ca, currentMode) {
  const cur = GAS_MODES[currentMode] || GAS_MODES.medium;
  return {
    text:
      `Select priority fee options\n` +
      `Current: ${cur.label}\n\n` +
      `Thunder Mode\n` +
      `🐢 Medium: +0 GWEI\n` +
      `🐴 Fast: +0.05 GWEI\n` +
      `🐋 Turbo: +0.1 GWEI\n\n` +
      `Anti-MEV Mode\n` +
      `🐢 Medium: +0 GWEI\n` +
      `🐴 Fast: +0.05 GWEI\n` +
      `🐋 Turbo: +0.1 GWEI\n\n` +
      `For custom priority fee, please directly enter the value in GWEI, for example: 5.`,
    keyboard: {
      inline_keyboard: [
        [
          { text: '🐢 Medium', callback_data: `gas_set_medium_${ca}` },
          { text: '🐴 Fast',   callback_data: `gas_set_fast_${ca}`   },
          { text: '🐋 Turbo',  callback_data: `gas_set_turbo_${ca}`  },
        ],
        [{ text: '❌ Close', callback_data: `gas_close_${ca}` }],
      ],
    },
  };
}

export function slippagePanel(ca, currentSlip) {
  const isAuto = !currentSlip || currentSlip === 0;
  const currentLabel = isAuto ? 'Auto' : `${Number(currentSlip).toFixed(2)}%`;
  return {
    text:
      `Set slippage, You can choose auto slippage or manually input in the input box, unit %\n` +
      `For example: 0.5\n` +
      `⚠️ if you enter "100", it is unlimited\n\n` +
      `Current value: ${currentLabel}\n\n` +
      `Manual setting suggestion\n` +
      `📌Thunder Mode, suggest 10-30, not less than 5\n` +
      `📌Anti-MEV Mode, suggest 20-50, ensure success rate`,
    keyboard: {
      inline_keyboard: [
        [{ text: '✅ Use Auto Slippage', callback_data: `slip_auto_${ca}` }],
        [{ text: '❌ Close', callback_data: `slip_close_${ca}` }],
      ],
    },
  };
}

function formatPrice(priceNum) {
  if (!priceNum || priceNum >= 0.01) return `$${(priceNum || 0).toFixed(4)}`;
  const str = priceNum.toFixed(20);
  const decimals = str.split('.')[1] || '';
  let zeros = 0;
  for (const c of decimals) { if (c === '0') zeros++; else break; }
  if (zeros <= 1) return `$${priceNum.toFixed(6)}`;
  const n = zeros - 1;
  const sig = decimals.slice(zeros, zeros + 4).replace(/0+$/, '');
  return `$0.0{${n}}${sig}`;
}

function autoSlippage(buyTax, sellTax) {
  const tax = Math.max(buyTax || 0, sellTax || 0);
  return Math.max(Math.ceil(tax * 2) + 5, 20);
}


async function getHoneypotInfo(ca) {
  const res = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${ca}&chainID=56`).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  return {
    isHoneypot: !!data.honeypotResult?.isHoneypot,
    honeypotReason: data.honeypotResult?.honeypotReason || null,
    buyTax: data.simulationResult?.buyTax ?? null,
    sellTax: data.simulationResult?.sellTax ?? null,
    transferTax: data.simulationResult?.transferTax ?? null,
    simulationSuccess: !!data.simulationSuccess,
    risk: data.summary?.risk || null,
    riskLevel: data.summary?.riskLevel ?? null,
    flags: data.flags || [],
    holders: data.token?.totalHolders ?? null,
    symbol: data.token?.symbol || null,
    name: data.token?.name || null,
    pairName: data.pair?.pair?.name || null,
    liquidity: data.pair?.liquidity ?? null,
    openSource: data.contractCode?.openSource ?? null,
  };
}

export function tokenMenu(ca, slippage = 0, antiMev = false, gasMode = 'medium', walletShort = '????', user = null, walletId = null) {
  const walletSuffix = walletId ? `_${walletId}` : '';
  const isAuto    = !slippage || slippage === 0;
  const slipLbl   = isAuto ? '🔧 Slippage Auto' : `✏️ Slippage ${Number(slippage).toFixed(0)}%`;
  const mevLabel  = antiMev ? '🛡️ Anti-MEV ON' : '🔴 Anti-MEV OFF';
  const gasBtn    = gasLabel(gasMode);

  const buys  = getCustomBuys(user);
  const sells = getCustomSells(user);

  const buyRows = [];
  for (let i = 0; i < buys.length; i += 3) {
    buyRows.push(buys.slice(i, i + 3).map(v => ({
      text: `Buy ${v} BNB`,
      callback_data: Buffer.byteLength(`buy_${ca}_${v}${walletSuffix}`) <= 64
        ? `buy_${ca}_${v}${walletSuffix}` : `buyx_${ca}${walletSuffix}`,
    })));
  }
  buyRows.push([{ text: '✏️ Buy X BNB', callback_data: `buyx_${ca}${walletSuffix}` }]);

  const sellRows = [];
  for (let i = 0; i < sells.length; i += 3) {
    sellRows.push(sells.slice(i, i + 3).map(v => ({
      text: `Sell ${v}%`,
      callback_data: `sell_${ca}_${v}${walletSuffix}`,
    })));
  }
  sellRows.push([{ text: '✏️ Sell X%', callback_data: `sellx_${ca}${walletSuffix}` }]);

  return {
    inline_keyboard: [
      [
        { text: '✅ Swap',    callback_data: 'noop'              },
        { text: '❌ Limit',   callback_data: `mode_limit_${ca}`  },
        { text: '🔄 Refresh', callback_data: `bs_refresh_${ca}`  },
      ],
      [
        { text: slipLbl,      callback_data: `slip_${ca}`                         },
        { text: '📊 Chart',   url:           `https://dexscreener.com/bsc/${ca}` },
        { text: '⬅️ Back',   callback_data: 'menu_back'                          },
      ],
      [
        { text: gasBtn,   callback_data: `gas_open_${ca}`   },
        { text: mevLabel, callback_data: `mev_toggle_${ca}` },
      ],
      [
        { text: `💳 ${walletShort}`, callback_data: `wallet_info_${ca}` },
      ],
      [
        { text: '◀ Previous wallet', callback_data: `wallet_prev_${ca}` },
        { text: 'Next wallet ▶', callback_data: `wallet_next_${ca}` },
      ],
      [
        { text: '🗂️ Multi Buy',  callback_data: `mode_multibuy_${ca}`  },
        { text: '🗂️ Multi Sell', callback_data: `mode_multisell_${ca}` },
      ],
      [{ text: '────── 🟢 Buy ──────', callback_data: 'noop' }],
      ...buyRows,
      [{ text: '────── 🔴 Sell ──────', callback_data: 'noop' }],
      ...sellRows,
    ],
  };
}

// ─── Multi-wallet buy/sell panel ─────────────────────────────────────────────
// balanceMap: Map<walletId, boolean> — only relevant for sell mode
export function multiWalletMenu(ca, mode, wallets, selectedIds, user, balanceMap = new Map()) {
  const isBuy = mode === 'buy';
  const buys  = getCustomBuys(user);
  const sells = getCustomSells(user);

  const selectedCount = wallets.filter(w => selectedIds.has(w.id)).length;

  const walletRows = [];
  for (let i = 0; i < wallets.length; i++) {
    walletRows.push(wallets.slice(i, i + 1).map(w => {
      const isSelected = selectedIds.has(w.id);
      const hasBalance = isBuy ? true : (balanceMap.get(w.id) ?? false);
      const dot = (isSelected && (isBuy || hasBalance)) ? '🟢' : '🔴';
      return {
        text: `${dot} ${walletLabel(w)}`,
        callback_data: `multi_tog_${mode}_${w.id}_${ca}`,
      };
    }));
  }

  const header = isBuy
    ? `💳 Multi Buy | ${selectedCount} wallet${selectedCount !== 1 ? 's' : ''} selected`
    : `💳 Multi Sell | ${selectedCount} wallet${selectedCount !== 1 ? 's' : ''} selected`;

  const anySelectedHasBalance = isBuy || wallets
    .filter(w => selectedIds.has(w.id))
    .some(w => balanceMap.get(w.id));

  const rows = [
    [{ text: '⬅️ Back', callback_data: `bs_refresh_${ca}` }],
    [{ text: header, callback_data: 'noop' }],
    ...walletRows,
    [
      { text: '✅ Turn All On',  callback_data: `multi_allon_${mode}_${ca}` },
      { text: '❌ Turn All Off', callback_data: `multi_alloff_${mode}_${ca}` },
    ],
  ];

  if (isBuy) {
    const amountRows = [];
    for (let i = 0; i < buys.length; i += 3) {
      amountRows.push(buys.slice(i, i + 3).map(v => ({
        text: `Buy ${v} BNB`,
        callback_data: selectedCount > 0 ? `multi_buy_${v}_${ca}` : 'noop',
      })));
    }
    rows.push([{ text: '──── 🟢 Amount per wallet ────', callback_data: 'noop' }]);
    rows.push(...amountRows);
    rows.push([{ text: '✏️ Buy X BNB', callback_data: `multi_buyx_${ca}` }]);
  } else {
    if (!anySelectedHasBalance || selectedCount === 0) {
      rows.push([{ text: '⚠️ No Balance Detected ⚠️', callback_data: 'noop' }]);
    } else {
      const sellRows = [];
      for (let i = 0; i < sells.length; i += 3) {
        sellRows.push(sells.slice(i, i + 3).map(v => ({
          text: `Sell ${v}%`,
          callback_data: `multi_sell_${v}_${ca}`,
        })));
      }
      rows.push([{ text: '──── 🔴 Percent per wallet ────', callback_data: 'noop' }]);
      rows.push(...sellRows);
      rows.push([{ text: '✏️ Sell X%', callback_data: `multi_sellx_${ca}` }]);
    }
  }

  return { inline_keyboard: rows };
}

// Tabs use different wallet roles, so both the text and keyboard must refresh.
export async function switchPanelMode(ctx, ca, msgId, mode) {
  // Wallet roles differ between tabs; reload text and balances with the keyboard.
  return showTokenPanel(ctx, ca, msgId, mode);
}

export async function showTokenPanel(ctx, ca, editMsgId = null, mode = 'swap') {
  const telegramId = ctx.from.id;
  let wallet;
  try { wallet = await (mode === 'limit' ? getActiveWalletData(telegramId) : getManualWalletData(telegramId)); }
  catch (error) { return ctx.reply(error.message); }

  const send = async (text, opts) => {
    if (editMsgId) {
      return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts).catch(() =>
        ctx.reply(text, opts)
      );
    }
    return ctx.reply(text, opts);
  };

  const loadMsg = editMsgId ? null : await ctx.reply('🔄 Loading token info...');
  const msgId = editMsgId || loadMsg.message_id;

  try {
    const [dex, bnbBalance, tokenBal, goplusSec, honeypot, tradeHistory, userData] = await Promise.allSettled([
      getPairData(ca),
      getBnbBalance(wallet.address),
      getTokenBalance(wallet.address, ca),
      scanToken(ca),
      getHoneypotInfo(ca),
      getAvgBuyPrice(telegramId, ca),
      getUser(telegramId),
    ]);

    const d        = dex.value;
    const sec      = goplusSec.value;
    const hp       = honeypot.value;
    const bnb      = bnbBalance.value || 0;
    const tok      = tokenBal.value;
    const trades   = tradeHistory.value;
    const user     = userData.value;
    const slippage = mode === 'limit'
      ? (user?.limit_slippage ?? user?.slippage ?? 0)
      : (user?.swap_slippage  ?? user?.slippage ?? 0);
    const antiMev  = !!(user?.anti_mev);
    const gasMode  = mode === 'limit'
      ? (user?.limit_gas_mode ?? user?.gas_mode ?? 'medium')
      : (user?.swap_gas_mode  ?? user?.gas_mode ?? 'medium');

    // Token identity — merge sources
    const symbol  = d?.baseToken?.symbol || hp?.symbol || sec?.symbol || '???';
    const dexName = d?._pairName || (d?.dexId
      ? (d.dexId === 'pancakeswap' ? 'PancakeSwap' : d.dexId)
      : (hp?.pairName || ''));

    // Price & market data — DexScreener first, GeckoTerminal/Moralis fallback
    const priceNum = d?.priceUsd ? parseFloat(d.priceUsd) : null;
    const priceStr = priceNum != null ? `$${priceNum < 0.000001 ? priceNum.toExponential(3) : priceNum < 0.01 ? priceNum.toPrecision(4) : priceNum.toFixed(6)}` : '?';
    const change   = d?.priceChange?.h24 != null
      ? `${d.priceChange.h24 >= 0 ? '+' : ''}${d.priceChange.h24.toFixed(2)}%` : '?';
    const mcapRaw  = d?.marketCap || d?.fdv || null;
    const mcap     = mcapRaw ? (mcapRaw >= 1e6 ? `$${(mcapRaw/1e6).toFixed(2)}M` : mcapRaw >= 1000 ? `$${(mcapRaw/1000).toFixed(2)}K` : `$${mcapRaw.toFixed(0)}`) : '?';
    // Liquidity: prefer pair data, fallback to Honeypot.is
    const liqUsd   = d?.liquidity?.usd ?? hp?.liquidity ?? null;
    const liqStr   = liqUsd != null ? `$${liqUsd >= 1000 ? (liqUsd/1000).toFixed(2)+'K' : liqUsd.toFixed(0)}${dexName ? ` (${dexName})` : ''}` : '?';

    // Taxes: prefer Honeypot.is simulation (more reliable), fallback GoPlus
    const buyTax  = hp?.buyTax  != null ? hp.buyTax  : sec?.buyTax;
    const sellTax = hp?.sellTax != null ? hp.sellTax : sec?.sellTax;
    const buyTaxStr  = buyTax  != null ? `${buyTax.toFixed(0)}%`  : '?';
    const sellTaxStr = sellTax != null ? `${sellTax.toFixed(0)}%` : '?';

    // Security check
    const isHoneypot = hp?.isHoneypot || sec?.isHoneypot;
    const flags = [];
    // GoPlus flags
    const ownerAddr = sec?.raw?.owner_address;
    if (ownerAddr && ownerAddr !== '0x0000000000000000000000000000000000000000' && ownerAddr !== '') {
      flags.push('HasOwner');
    }
    if (sec?.isMintable)                      flags.push('Mintable');
    if (sec?.isBlacklisted)                   flags.push('Blacklist');
    if (sec?.tradingCooldown)                 flags.push('TradingCooldown');
    if (sec?.raw?.can_take_back_ownership === '1') flags.push('CanTakeBackOwnership');
    if (sec?.raw?.is_open_source === '0')     flags.push('NotOpenSource');
    if (sec?.raw?.is_anti_whale === '1')      flags.push('AntiWhale');
    // Honeypot.is flags (strings)
    if (hp?.flags?.length) {
      for (const f of hp.flags) {
        const label = typeof f === 'string' ? f : f?.flag || f?.name || JSON.stringify(f);
        if (label && !flags.includes(label)) flags.push(label);
      }
    }

    let secEmoji, secLabel;
    if (isHoneypot) {
      secEmoji = '🔴'; secLabel = 'HONEYPOT';
    } else if (hp?.riskLevel >= 3 || sec?.cannotSell) {
      secEmoji = '🔴'; secLabel = 'High Risk';
    } else if (hp?.riskLevel >= 1 || flags.length > 0) {
      secEmoji = '🟡'; secLabel = 'Security issues detected';
    } else if (hp?.simulationSuccess || sec) {
      secEmoji = '🟢'; secLabel = 'OK';
    } else {
      secEmoji = '⚪'; secLabel = 'Unknown';
    }

    // Holdings
    const tokenAmt  = tok?.formatted || 0;
    const tokenSym  = tok?.symbol || symbol;
    const holdingUsd = priceNum && tokenAmt ? priceNum * tokenAmt : 0;
    const holdingBnb = 0; // would need BNB price to calculate exactly

    // Build the message
    let text =
      `📌【BSC】<b><a href="https://buzzo.trade">${symbol}</a></b>\n` +
      `CA: <code>${ca}</code>\n\n` +
      `📈Price: <b>${priceStr}</b>  24h: ${change}\n` +
      `| MCap: ${mcap}\n` +
      `| Liquidity: ${liqStr}\n` +
      `| Buy Tax: ${buyTaxStr}  Sell Tax: ${sellTaxStr}\n` +
      `| Security Check: ${secEmoji} ${secLabel}`;

    if (flags.length > 0) {
      text += `\n⚠️${flags.join(' | ')}`;
    }

    // PnL calculation
    const avgBuyPriceUsd = trades?.avg_price_usd ? parseFloat(trades.avg_price_usd) : 0;
    let pnlLine = '| AVG Buy Price: — | Unrealized PnL: —';
    if (avgBuyPriceUsd > 0 && priceNum > 0 && tokenAmt > 0) {
      const pnlPct = ((priceNum - avgBuyPriceUsd) / avgBuyPriceUsd) * 100;
      const pnlUsd = (priceNum - avgBuyPriceUsd) * tokenAmt;
      const pnlSign  = pnlPct >= 0 ? '+' : '';
      const pnlEmoji = pnlPct >= 0 ? '🟢' : '🔴';
      pnlLine =
        `| AVG Buy Price: ${formatPrice(avgBuyPriceUsd)}\n` +
        `| Unrealized PnL: ${pnlSign}$${Math.abs(pnlUsd).toFixed(2)} ${pnlEmoji}${pnlSign}${pnlPct.toFixed(2)}%`;
    } else if (avgBuyPriceUsd === 0 && trades?.total_bnb > 0) {
      pnlLine = '| AVG Buy Price: — (no price data) | Unrealized PnL: —';
    }

    text +=
      `\n\n💰Holding $${holdingUsd.toFixed(2)} / ${tokenAmt.toFixed(2)} ${tokenSym}\n` +
      `${pnlLine}\n` +
      `💳 ${mode === 'limit' ? 'Default' : 'Manual'}: <b>${escHtml(walletLabel(wallet))}</b>\n` +
      `<code>${wallet.address}</code>\n` +
      `Balance: ${bnb.toFixed(4)} BNB | ${tokenAmt.toFixed(2)} ${tokenSym}`;

    const keyboard = mode === 'limit'
      ? limitMenu(ca, slippage, antiMev, gasMode, walletLabel(wallet), user)
      : tokenMenu(ca, slippage, antiMev, gasMode, walletLabel(wallet), user, wallet.id);

    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    }).catch(err => {
      if (!err.message?.includes('message is not modified')) throw err;
    });
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null,
      `❌ Failed to load token: ${e.message}`
    ).catch(() => ctx.reply(`❌ Failed to load token: ${e.message}`));
  }
}

async function getBnbUsdPrice() {
  try {
    const res  = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
    const data = await res.json();
    return parseFloat(data.price || 0);
  } catch {
    return 0;
  }
}

export async function executeBuy(ctx, ca, bnbAmount, expectedWalletId = null) {
  const telegramId = ctx.from.id;
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please /start first.');

  let wallet;
  try { wallet = await getManualWalletData(telegramId); }
  catch (error) { return ctx.reply(error.message); }
  if (expectedWalletId != null && Number(wallet.id) !== Number(expectedWalletId))
    return ctx.reply('Manual wallet changed. Refresh the token panel before buying. No trade was sent.');
  const backBtn = { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `bs_refresh_${ca}` }]] } };

  const bnbPrice = await getBnbUsdPrice();
  if (bnbPrice > 0 && bnbAmount * bnbPrice < 5) {
    return ctx.reply('At least $5 of amount is required', backBtn);
  }

  const balance = await getBnbBalance(wallet.address).catch(() => 0);
  if (balance < bnbAmount + 0.002) {
    return ctx.reply(
      `${walletLabel(wallet)} has insufficient balance, please recharge BNB or change wallet`,
      backBtn
    );
  }

  const antiMev = !!(user.anti_mev);
  const gasMode = user.swap_gas_mode  ?? user.gas_mode  ?? 'medium';
  const slip    = user.swap_slippage  ?? user.slippage  ?? 0;
  const slipAmt = slip || 10;
  const msg = await ctx.reply(`🔄 ${walletLabel(wallet)} — Buying with ${bnbAmount} BNB...${antiMev ? ' (🛡️ Anti-MEV)' : ''}`);
  try {
    const result = await autoSwapBuy(wallet.privateKey, ca, bnbAmount, slipAmt, antiMev, gasMode, telegramId);
    let tokenPriceUsd = 0;
    try {
      const pr = await getPairData(ca);
      tokenPriceUsd = pr?.priceUsd ? parseFloat(pr.priceUsd) : 0;
    } catch {}
    await saveTrade(telegramId, ca, 'buy', bnbAmount, result.platFee || 0, result.txHash, 'success', tokenPriceUsd || null);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      buySuccessMsg(ca, result.swapBnb, result.txHash, result.router, result.tokensReceived, result.tokenSymbol, 0, 0, walletLabel(wallet), result),
      { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `bs_refresh_${ca}` }]] } }
    );
  } catch (e) {
    await saveTrade(telegramId, ca, 'buy', bnbAmount, 0, null, 'failed');
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      buyFailMsg(ca, e),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `bs_refresh_${ca}` }]] } }
    );
  }
}

export async function executeSell(ctx, ca, percent, expectedWalletId = null) {
  const telegramId = ctx.from.id;
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please /start first.');

  let wallet;
  try { wallet = await getManualWalletData(telegramId); }
  catch (error) { return ctx.reply(error.message); }
  if (expectedWalletId != null && Number(wallet.id) !== Number(expectedWalletId))
    return ctx.reply('Manual wallet changed. Refresh the token panel before selling. No trade was sent.');
  const backBtn = { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `bs_refresh_${ca}` }]] } };

  let tokenBal;
  try {
    tokenBal = await getTokenBalance(wallet.address, ca);
  } catch (e) {
    return ctx.reply(`❌ Could not read balance: ${e.message}`);
  }

  if (!tokenBal || tokenBal.formatted <= 0) {
    return ctx.reply(
      `${walletLabel(wallet)} has insufficient balance, please recharge BNB or change wallet`,
      backBtn
    );
  }

  // $5 minimum check — use token USD price from DexScreener
  const dex        = await getPairData(ca).catch(() => null);
  const tokenPrice = dex?.priceUsd ? parseFloat(dex.priceUsd) : 0;
  const sellValue  = tokenBal.formatted * (percent / 100) * tokenPrice;
  if (tokenPrice > 0 && sellValue < 5) {
    return ctx.reply('At least $5 of amount is required', backBtn);
  }

  const antiMev = !!(user.anti_mev);
  const gasMode = user.swap_gas_mode  ?? user.gas_mode  ?? 'medium';
  const slip    = user.swap_slippage  ?? user.slippage  ?? 0;
  const slipAmt = slip || 10;
  const msg = await ctx.reply(`🔄 ${walletLabel(wallet)} — Selling ${percent}% of ${tokenBal.symbol}...${antiMev ? ' (🛡️ Anti-MEV)' : ''}`);
  try {
    const result = await autoSwapSell(wallet.privateKey, ca, percent, slipAmt, antiMev, gasMode, telegramId);
    const receivedBnb = result.receivedBnb || 0;
    const feeAmt = result.platFee || 0;
    await saveTrade(telegramId, ca, 'sell', receivedBnb, feeAmt, result.txHash, 'success');
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      sellSuccessMsg(ca, tokenBal.symbol, percent, result.receivedBnb, result.txHash, result.router, 0, 0, walletLabel(wallet), result),
      { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `bs_refresh_${ca}` }]] } }
    );
  } catch (e) {
    await saveTrade(telegramId, ca, 'sell', 0, 0, null, 'failed');
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      sellFailMsg(ca, e),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `bs_refresh_${ca}` }]] } }
    );
  }
}

export async function executeMultiBuy(ctx, ca, bnbAmount, walletIds) {
  const telegramId = ctx.from.id;
  const user = await getUser(telegramId);
  const wallets = (await getUserWallets(telegramId)).filter(w => w.is_manual && walletIds.has(w.id));
  if (wallets.length !== walletIds.size) return ctx.reply('A selected Manual wallet is disabled or removed. Refresh the selection. No trade was sent.');
  if (!wallets.length) return ctx.reply('❌ No wallets selected.');
  const antiMev = !!(user.anti_mev);
  const gasMode = user.swap_gas_mode ?? user.gas_mode ?? 'medium';
  const slipAmt = resolveSlippage(user);
  await ctx.reply(`🗂️ <b>Multi Buy</b> — ${wallets.length} wallet(s) × ${bnbAmount} BNB`, { parse_mode: 'HTML' });
  for (const w of wallets) {
    const msg = await ctx.reply(`🔄 <b>${escHtml(walletLabel(w))}</b> buying ${bnbAmount} BNB...`, { parse_mode: 'HTML' });
    try {
      const {privateKey:pk} = await getManualWalletByIdData(telegramId,w.id);
      const bnbBal = await getBnbBalance(w.address).catch(() => 0);
      if (bnbBal < bnbAmount + 0.002) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `❌ <b>${escHtml(w.name)}</b> — low BNB (${parseFloat(bnbBal).toFixed(5)})`, { parse_mode: 'HTML' });
        continue;
      }
      const result = await autoSwapBuy(pk, ca, bnbAmount, slipAmt, antiMev, gasMode, telegramId);
      await saveTrade(telegramId, ca, 'buy', bnbAmount, result.platFee || 0, result.txHash, 'success', null);
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        buySuccessMsg(ca, result.swapBnb, result.txHash, result.router, result.tokensReceived, result.tokenSymbol, 0, 0, walletLabel(w), result),
        { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      await saveTrade(telegramId, ca, 'buy', bnbAmount, 0, null, 'failed');
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `<b>${escHtml(w.name)}</b>\n${buyFailMsg(ca, e)}`, { parse_mode: 'HTML' });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  await ctx.reply('✅ Multi Buy done.');
}

export async function executeMultiSell(ctx, ca, percent, walletIds) {
  const telegramId = ctx.from.id;
  const user = await getUser(telegramId);
  const wallets = (await getUserWallets(telegramId)).filter(w => w.is_manual && walletIds.has(w.id));
  if (wallets.length !== walletIds.size) return ctx.reply('A selected Manual wallet is disabled or removed. Refresh the selection. No trade was sent.');
  if (!wallets.length) return ctx.reply('❌ No wallets selected.');
  const antiMev = !!(user.anti_mev);
  const gasMode = user.swap_gas_mode ?? user.gas_mode ?? 'medium';
  const slipAmt = resolveSlippage(user);
  await ctx.reply(`🗂️ <b>Multi Sell</b> — ${wallets.length} wallet(s) selling ${percent}%`, { parse_mode: 'HTML' });
  for (const w of wallets) {
    const msg = await ctx.reply(`🔄 <b>${escHtml(walletLabel(w))}</b> selling ${percent}%...`, { parse_mode: 'HTML' });
    try {
      const {privateKey:pk} = await getManualWalletByIdData(telegramId,w.id);
      const tokenBal = await getTokenBalance(w.address, ca);
      if (!tokenBal || parseFloat(tokenBal.formatted) <= 0) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `⏭️ <b>${escHtml(w.name)}</b> — no balance`, { parse_mode: 'HTML' });
        continue;
      }
      const bnbBal = await getBnbBalance(w.address).catch(() => 0);
      if (bnbBal < 0.0005) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `⏭️ <b>${escHtml(w.name)}</b> — no BNB for gas (${parseFloat(bnbBal).toFixed(5)})`, { parse_mode: 'HTML' });
        continue;
      }
      const result = await autoSwapSell(pk, ca, percent, slipAmt, antiMev, gasMode, telegramId);
      const bnbReceived = result.receivedBnb || 0;
      await saveTrade(telegramId, ca, 'sell', bnbReceived, result.platFee || 0, result.txHash, 'success');
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        sellSuccessMsg(ca, result.tokenSymbol, percent, result.receivedBnb, result.txHash, result.router, 0, 0, walletLabel(w), result),
        { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      await saveTrade(telegramId, ca, 'sell', 0, 0, null, 'failed');
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `<b>${escHtml(w.name)}</b>\n${sellFailMsg(ca, e)}`, { parse_mode: 'HTML' });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  await ctx.reply('✅ Multi Sell done.');
}
