import {
  getUser, getAutoSellRules, createAutoSellRule,
  toggleAutoSellRule, deleteAutoSellRule, setUserAutoSell,
} from '../lib/db.js';

function ruleLabel(r) {
  const dir   = r.trigger_pct >= 0 ? `TP +${r.trigger_pct}%` : `SL ${r.trigger_pct}%`;
  const trail = r.trailing ? ' 🔄Trail' : '';
  const en    = r.enabled ? '✅' : '❌';
  return `${en} ${dir}${trail}  Sell: ${r.sell_pct}%`;
}

export async function showAutoSellPage(ctx, telegramId, editMsgId = null) {
  const user  = await getUser(telegramId);
  const rules = await getAutoSellRules(telegramId);
  const asEnabled = !!(user?.autosell_enabled);

  const infoText =
    `🔥 <b>Auto Sell</b>\n\n` +
    `You can configure multiple TP/SL rules. Once the rules are activated, newly purchased tokens will be executed based on these rules.\n\n` +
    `<b>Features:</b>\n` +
    `- Set up multiple TP/SL rules and turn them on/off individually\n` +
    `- To remove a rule, tap its button and choose Delete\n` +
    `- Auto-sell only works for market and limit orders\n\n` +
    `<b>Example Rule Configuration:</b>\n` +
    `- Stop-Loss: -50%, sell 100%\n` +
    `- Take-Profit: 50%, sell 50%\n` +
    `- Take-Profit: 100%, sell 50%\n\n` +
    `<b>Trailing Stop-Loss:</b>\n` +
    `Tracks peak price and triggers when price drops X% from peak.\n\n` +
    `Status: <b>${asEnabled ? '✅ Active (applies to new buys)' : '❌ Disabled'}</b>`;

  const ruleRows = rules.map(r => ([
    { text: ruleLabel(r), callback_data: `as_toggle_${r.id}` },
    { text: '🗑️ Del',    callback_data: `as_del_${r.id}`    },
  ]));

  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Add Sell Rule', callback_data: 'as_add' }],
      ...ruleRows,
      [
        {
          text: asEnabled ? '✅ Auto Sell ON — Disable' : '❌ Auto Sell OFF — Enable',
          callback_data: 'as_toggle_global',
        },
      ],
      [
        { text: '⬅️ Back', callback_data: 'cfg_global' },
        { text: '✖️ Close', callback_data: 'cfg_close' },
      ],
    ],
  };

  const opts = { parse_mode: 'HTML', reply_markup: keyboard };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, infoText, opts)
      .catch(() => ctx.reply(infoText, opts));
  }
  return ctx.reply(infoText, opts);
}

export async function showAddRulePage(ctx, telegramId, editMsgId = null) {
  const text =
    `➕ <b>Add Auto Sell Rule</b>\n\n` +
    `Choose a rule type to add:`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📈 Take-Profit',       callback_data: 'as_addtype_tp'       },
        { text: '📉 Stop-Loss',         callback_data: 'as_addtype_sl'       },
      ],
      [
        { text: '🔄 Trailing Stop-Loss', callback_data: 'as_addtype_trailing' },
      ],
      [{ text: '⬅️ Back', callback_data: 'cfg_autosell' }],
    ],
  };

  const opts = { parse_mode: 'HTML', reply_markup: keyboard };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts)
      .catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}
