import { getUserTradeHistory } from '../lib/db.js';

function formatDate(dt) {
  const d = new Date(dt);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export async function handleHistory(ctx) {
  const telegramId = ctx.from.id;
  const msg = await ctx.reply('🔄 Loading trade history...');
  try {
    const trades = await getUserTradeHistory(telegramId, 20);

    if (!trades.length) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        '📭 <b>No trade history yet.</b>\n\nPaste any token address to start trading!',
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '❌ Close', callback_data: 'close_msg' }]] },
        }
      );
    }

    const lines = trades.map((t, i) => {
      const verb    = t.direction === 'buy' ? '🟢 Buy' : '🔴 Sell';
      const short   = `${t.ca.slice(0, 6)}…${t.ca.slice(-4)}`;
      const amt     = `${parseFloat(t.amount_bnb).toFixed(4)} BNB`;
      const status  = t.status === 'success' ? '✅' : '❌';
      const date    = formatDate(t.created_at);
      const price   = t.price_usd && parseFloat(t.price_usd) > 0
        ? ` @ $${parseFloat(t.price_usd).toExponential(3)}`
        : '';
      const txLink  = t.tx_hash
        ? ` <a href="https://bscscan.com/tx/${t.tx_hash}">Tx</a>`
        : '';
      return `${status} ${verb} ${amt}${price}\n   <code>${short}</code> · ${date}${txLink}`;
    });

    const text = `📜 <b>Trade History</b> (last ${trades.length})\n\n${lines.join('\n\n')}`;

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '❌ Close', callback_data: 'close_msg' }]] },
    });
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `❌ Failed to load history: ${e.message}`
    ).catch(() => {});
  }
}
