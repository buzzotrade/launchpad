import { getUserLimitOrders, cancelLimitOrder, cancelAllLimitOrders, createLimitOrder, getCustomBuys, getCustomSells } from '../lib/db.js';

// ─── Trigger price parser ─────────────────────────────────────────────────────
// Accepts: -5%  +5%  5%  0.00041  $0.00041
export function parseTriggerPrice(input, currentPrice) {
  const s = input.trim();

  const pctMatch = s.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    return +(currentPrice * (1 + pct / 100)).toPrecision(8);
  }

  const priceStr = s.replace(/^\$/, '');
  const price    = parseFloat(priceStr);
  if (!isNaN(price) && price > 0) return price;

  return null;
}

// ─── Limit mode keyboard ──────────────────────────────────────────────────────
export function limitMenu(ca, slippage = 0, antiMev = false, gasMode = 'medium', walletShort = '????', user = null) {
  const isAuto   = !slippage || slippage === 0;
  const slipLbl  = isAuto ? '🔧 Slippage Auto (10%)' : `✏️ Slippage ${Number(slippage).toFixed(0)}%`;
  const mevLabel = antiMev ? '🛡️ Anti-MEV ON' : '🔴 Anti-MEV OFF';

  const gasLabels = { medium: '⛽ Gas 🐢 Medium', fast: '⛽ Gas 🐴 Fast', turbo: '⛽ Gas 🐋 Turbo' };
  const gasBtn    = gasLabels[gasMode] || `⛽ Gas ${gasMode}`;

  const buys  = getCustomBuys(user);
  const sells = getCustomSells(user);

  const buyRows = [];
  for (let i = 0; i < buys.length; i += 3) {
    buyRows.push(buys.slice(i, i + 3).map(v => ({
      text: `Buy ${v} BNB`,
      callback_data: `lbuy_${ca}_${v}`,
    })));
  }
  buyRows.push([{ text: '✏️ Buy X BNB', callback_data: `lbuyx_${ca}` }]);

  const sellRows = [];
  for (let i = 0; i < sells.length; i += 3) {
    sellRows.push(sells.slice(i, i + 3).map(v => ({
      text: `Sell ${v}%`,
      callback_data: `lsell_${ca}_${v}`,
    })));
  }
  sellRows.push([{ text: '✏️ Sell X%', callback_data: `lsellx_${ca}` }]);

  return {
    inline_keyboard: [
      [
        { text: '❌ Swap',    callback_data: `mode_swap_${ca}` },
        { text: '✅ Limit',   callback_data: 'noop'            },
        { text: '🔄 Refresh', callback_data: `bs_refresh_${ca}` },
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
      [{ text: '────── 🟢 Limit Buy ──────', callback_data: 'noop' }],
      ...buyRows,
      [{ text: '────── 🔴 Limit Sell ──────', callback_data: 'noop' }],
      ...sellRows,
    ],
  };
}

// ─── Trigger price prompt ─────────────────────────────────────────────────────
export async function promptTriggerPrice(ctx, ca, side, amount, currentPrice) {
  const verb   = side === 'buy' ? 'Buy' : 'Sell';
  const amtStr = side === 'buy' ? `${amount} BNB` : `${amount}%`;

  await ctx.reply(
    `📌 <b>${verb} ${amtStr}</b> — Set Limit Trigger\n\n` +
    `Enter the trigger price of the limit order. Valid options are:\n` +
    `• % change (e.g. <code>-5%</code> or <code>5%</code>)\n` +
    `• A specific price (e.g. <code>0.1</code> or <code>$0.1</code>)\n\n` +
    `Current Price: <b>$${currentPrice > 0 ? currentPrice.toFixed(8) : '?'}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Close', callback_data: 'limit_cancel_input' }]],
      },
    }
  );
}

// ─── Confirm order created ────────────────────────────────────────────────────
export async function confirmLimitOrder(ctx, order, triggerPrice, currentPrice, originalInput, ca) {
  const verb     = order.side === 'buy' ? '🟢 Limit Buy' : '🔴 Limit Sell';
  const amtStr   = order.side === 'buy' ? `${parseFloat(order.amount)} BNB` : `${parseFloat(order.amount)}%`;
  const dir      = order.side === 'buy' ? '≤' : '≥';
  const diff     = currentPrice > 0 ? (((triggerPrice - currentPrice) / currentPrice) * 100).toFixed(2) : '?';
  const diffStr  = diff !== '?' ? `${parseFloat(diff) >= 0 ? '+' : ''}${diff}%` : '';

  await ctx.reply(
    `✅ <b>Limit Order Created!</b>\n\n` +
    `${verb}\n` +
    `Token: <code>${ca}</code>\n` +
    `Amount: <b>${amtStr}</b>\n` +
    `Trigger: when price ${dir} <b>$${triggerPrice.toFixed(8)}</b> ${diffStr}\n` +
    `Input: <code>${originalInput}</code>\n` +
    `Order ID: <b>#${order.id}</b>\n\n` +
    `The bot will execute automatically when triggered.\n` +
    `Use /limitorder to view or cancel your orders.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `❌ Cancel Order #${order.id}`, callback_data: `limit_cancel_${order.id}` }],
        ],
      },
    }
  );
}

// ─── /limit command — list active orders ─────────────────────────────────────
export async function handleLimitCommand(ctx) {
  const telegramId = ctx.from.id;

  await ctx.reply(
    `⚙️ <b>Limit Orders</b>\n\n` +
    `🔶 Please enter the token contract address to add a limit order\n\n` +
    `Or see your active orders below.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'limit_list_refresh' }],
          [{ text: '❌ Cancel All Limit Orders', callback_data: 'limit_cancel_all' }],
        ],
      },
    }
  );

  await showLimitOrdersList(ctx, telegramId);
}

// ─── Show orders list (standalone message) ────────────────────────────────────
export async function showLimitOrdersList(ctx, telegramId) {
  const orders = await getUserLimitOrders(telegramId);
  if (!orders.length) {
    return ctx.reply('📋 No active limit orders.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'limit_list_refresh' }]],
      },
    });
  }

  const lines = orders.map(o => {
    const verb  = o.side === 'buy' ? '🟢 Buy' : '🔴 Sell';
    const amt   = o.side === 'buy' ? `${parseFloat(o.amount)} BNB` : `${parseFloat(o.amount)}%`;
    const short = `${o.ca.slice(0, 6)}…${o.ca.slice(-4)}`;
    return `#${o.id} ${verb} ${amt} of ${short} @ $${parseFloat(o.trigger_price).toFixed(8)}`;
  });

  const cancelButtons = orders.map(o => ([{
    text: `❌ Cancel #${o.id}`,
    callback_data: `limit_cancel_${o.id}`,
  }]));

  await ctx.reply(
    `⚙️ <b>Active Limit Orders (${orders.length})</b>\n\n` + lines.join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...cancelButtons,
          [{ text: '🔄 Refresh',                callback_data: 'limit_list_refresh' }],
          [{ text: '❌ Cancel All Limit Orders', callback_data: 'limit_cancel_all'   }],
        ],
      },
    }
  );
}

// ─── Cancel single order ──────────────────────────────────────────────────────
export async function handleCancelLimitOrder(ctx, orderId) {
  const telegramId = ctx.from.id;
  const affected   = await cancelLimitOrder(orderId, telegramId);
  if (affected) {
    await ctx.answerCbQuery(`✅ Order #${orderId} cancelled.`);
  } else {
    await ctx.answerCbQuery('⚠️ Order not found or already complete.', { show_alert: true });
  }
  await showLimitOrdersList(ctx, telegramId);
}

// ─── Cancel all orders ────────────────────────────────────────────────────────
export async function handleCancelAllLimitOrders(ctx) {
  const telegramId = ctx.from.id;
  const n          = await cancelAllLimitOrders(telegramId);
  await ctx.answerCbQuery(n ? `✅ ${n} order(s) cancelled.` : 'No pending orders.', { show_alert: true });
  await showLimitOrdersList(ctx, telegramId);
}
