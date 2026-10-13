import { getUser, getCustomBuys, getCustomSells } from '../lib/db.js';
import { resolveSlippage } from '../lib/slippage.js';

function gasLabel(gasMode) {
  if (!gasMode || gasMode === 'medium') return '🐢 Medium';
  if (gasMode === 'fast')  return '🐴 Fast';
  if (gasMode === 'turbo') return '🐋 Turbo';
  return `${gasMode} GWEI`;
}

function slipLabel(slip) {
  return (!slip || slip == 0) ? '10%' : `${Number(slip).toFixed(0)}%`;
}

export async function handleSettings(ctx) {
  return ctx.reply(
    `Please select setting item~`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚙️ Global Trade Settings', callback_data: 'cfg_global' }],
          [{ text: '⬅️ Back', callback_data: 'menu_back' }],
        ],
      },
    }
  );
}

export async function showGlobalTradeSettings(ctx, editMsgId = null) {
  const telegramId = ctx.from.id;
  const user = await getUser(telegramId);

  const swap_slip   = slipLabel(user?.slippage);
  const swap_gas    = gasLabel(user?.gas_mode);
  const pre_app_gas = Number(user?.pre_approve_gas ?? 0.05).toFixed(2);
  const xfer_gas    = Number(user?.transfer_gas ?? 0.05).toFixed(2);
  const snp_slip    = resolveSlippage(user, 'sniper').toFixed(2);
  const snp_gas     = Number(user?.sniper_gas ?? 3).toFixed(0);
  const snp_liq     = Number(user?.snipe_min_liq ?? 0.05).toFixed(2);

  const buys  = getCustomBuys(user);
  const sells = getCustomSells(user);
  const buyStr  = buys.map(v => `${v} BNB`).join(' | ');
  const sellStr = sells.map(v => `${v}%`).join(' | ');
  const autoSell = user?.autosell_enabled ? '✅ ON' : '❌ OFF';

  const text =
    `Network: BSC\n\n` +
    `The default trading settings are showed as follows. If you need to edit them, click the corresponding button below\n\n` +
    `Swap Slippage: ${swap_slip}\n` +
    `Swap Gas Fee: ${swap_gas}\n` +
    `Pre Approve Extra Gas: ${pre_app_gas} GWEI\n` +
    `Transfer Extra Gas: ${xfer_gas} GWEI\n` +
    `Sniper Slippage: ${snp_slip}%\n` +
    `Sniper Gas Fee: ${snp_gas} GWEI\n` +
    `Snipe Min Liquidity: ${snp_liq} BNB\n\n` +
    `Custom Buy: ${buyStr || '—'}\n` +
    `Custom Sell: ${sellStr || '—'}\n` +
    `Auto Sell: ${autoSell}`;

  const buyBtns = buys.map((v, i) => ({
    text: `✏️ ${v} BNB`,
    callback_data: `cfg_custbuy_${i + 1}`,
  }));

  const sellBtns = sells.map((v, i) => ({
    text: `✏️ ${v}%`,
    callback_data: `cfg_custsell_${i + 1}`,
  }));

  const buyRows  = [];
  for (let i = 0; i < buyBtns.length; i += 3) buyRows.push(buyBtns.slice(i, i + 3));
  const sellRows = [];
  for (let i = 0; i < sellBtns.length; i += 3) sellRows.push(sellBtns.slice(i, i + 3));

  const keyboard = {
    inline_keyboard: [
      [
        { text: '« BSC »',            callback_data: 'cfg_chain_info'         },
        { text: '✏️ Swap Slippage',  callback_data: 'cfg_set_slippage'        },
      ],
      [{ text: '✏️ Swap Gas Fee',     callback_data: 'cfg_set_gas'            }],
      [
        { text: '✏️ Pre Approve Extra Gas', callback_data: 'cfg_set_pre_approve_gas' },
        { text: '✏️ Transfer Extra Gas',    callback_data: 'cfg_set_transfer_gas'    },
      ],
      [
        { text: '✏️ Sniper Slippage', callback_data: 'cfg_set_sniper_slippage' },
        { text: '✏️ Sniper Gas Fee',  callback_data: 'cfg_set_sniper_gas'      },
      ],
      [{ text: '✏️ Snipe Min Liquidity', callback_data: 'cfg_set_snipe_min_liq' }],
      [{ text: '--------- 🟢 Custom Buy ---------', callback_data: 'noop' }],
      ...buyRows,
      [{ text: '✏️ Add/Edit Buy Slot', callback_data: 'cfg_custbuy_add' }],
      [{ text: '--------- 🔴 Custom Sell ---------', callback_data: 'noop' }],
      ...sellRows,
      [{ text: '✏️ Add/Edit Sell Slot', callback_data: 'cfg_custsell_add' }],
      [
        { text: '🔥 Auto Sell',   callback_data: 'cfg_autosell' },
        { text: '✅ PnL Values', callback_data: 'noop'          },
      ],
      [
        { text: '⬅️ Back',  callback_data: 'cfg_back'  },
        { text: '✖️ Close', callback_data: 'cfg_close' },
      ],
    ],
  };

  if (editMsgId) {
    await ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, {
      reply_markup: keyboard,
    }).catch(err => {
      if (!err.message?.includes('message is not modified')) throw err;
    });
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

export function gasPickerKeyboard(ca = null) {
  const prefix = ca ? `cfg_gas_ca_` : 'cfg_gas_';
  const suffix = ca ? `_${ca}` : '';
  return {
    inline_keyboard: [
      [
        { text: '🐢 Medium', callback_data: `${prefix}medium${suffix}` },
        { text: '🐴 Fast',   callback_data: `${prefix}fast${suffix}`   },
        { text: '🐋 Turbo',  callback_data: `${prefix}turbo${suffix}`  },
      ],
      [{ text: '❌ Close', callback_data: 'cfg_gas_close' }],
    ],
  };
}
