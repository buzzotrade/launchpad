import QRCode from 'qrcode';
import { getUserWallets } from '../lib/db.js';

function shortAddr(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function walletTag(w) {
  return w.address.slice(-4);
}

export async function showReceivePage(ctx, telegramId, editMsgId = null) {
  const wallets = await getUserWallets(telegramId);

  const text =
    `📥 <b>Receive</b>\n\n` +
    `Network: <b>BSC</b>\n\n` +
    `Please select the wallet to which you want to receive`;

  const rows = wallets.map(w => ([{
    text: `💳 Wallet ${walletTag(w)}${w.is_default ? ' ★' : ''}`,
    callback_data: `receive_qr_${w.id}`,
  }]));

  const keyboard = {
    inline_keyboard: [
      ...rows,
      [{ text: '⬅️ Back', callback_data: 'menu_main' }],
    ],
  };

  const opts = { parse_mode: 'HTML', reply_markup: keyboard };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts)
      .catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}

export async function showReceiveQR(ctx, telegramId, walletId) {
  const wallets = await getUserWallets(telegramId);
  const wallet = wallets.find(w => w.id === walletId);
  if (!wallet) return ctx.answerCbQuery('Wallet not found.', { show_alert: true });

  const chatId = ctx.chat.id;
  const address = wallet.address;

  const qrBuffer = await QRCode.toBuffer(address, {
    type: 'png',
    width: 512,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  await ctx.telegram.sendMessage(chatId, `<code>${address}</code>`, {
    parse_mode: 'HTML',
  });

  await ctx.telegram.sendPhoto(chatId, { source: qrBuffer }, {
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_receive' }]],
    },
  });

  await ctx.telegram.sendMessage(
    chatId,
    `The payment address and QR code have been sent. Current network: <b>&lt;&lt;bsc&gt;&gt;</b>.\nPlease note: Using the wrong network may result in the loss of your assets`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_receive' }]],
      },
    }
  );
}
