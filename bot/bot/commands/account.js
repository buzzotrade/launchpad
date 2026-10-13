import { getUserWallets, getWallet, deleteWallet } from '../lib/db.js';
import { getBnbBalance, getWalletTokens } from '../lib/walletLib.js';
import { walletLabel } from '../lib/walletLabel.js';

function fmtAmt(n, symbol) {
  let s;
  if (n >= 1_000_000) s = `${(n / 1_000_000).toFixed(2)}M`;
  else if (n >= 1)    s = n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  else if (n >= 0.01) s = n.toFixed(2);
  else                s = n.toExponential(2);
  return `${s} ${symbol}`;
}

function shortAddr(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function walletTag(w) {
  return walletLabel(w);
}

// ─── Main Account Page ────────────────────────────────────────────────────────
export async function showAccountPage(ctx, telegramId, editMsgId = null) {
  const wallets = await getUserWallets(telegramId);

  const [balances, tokenLists] = await Promise.all([
    Promise.all(wallets.map(w => getBnbBalance(w.address).catch(() => 0))),
    Promise.all(wallets.map(w => getWalletTokens(w.address).catch(() => []))),
  ]);

  const lines = wallets.map((w, i) => {
    const bnb    = Number(balances[i] || 0).toFixed(4);
    const tag    = walletTag(w);
    const num    = String(i + 1).padStart(2, '0');
    const def    = w.is_default ? ' ★' : '';
    const tokens = tokenLists[i];
    const tkLine = tokens.length
      ? '\n' + tokens.map(t => `  • ${fmtAmt(t.formatted, t.symbol)}`).join('\n')
      : '\n  • No tokens held';
    const label = tag.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `${num}: <b>${label}${def}</b>\n<a href="https://bscscan.com/address/${w.address}">${w.address}</a>\n  💰 ${bnb} BNB${tkLine}`;
  }).join('\n\n');

  const text =
    `🔒 <b>Account — BSC</b>\n\n` +
    `There are a total of <b>${wallets.length}</b> wallet${wallets.length !== 1 ? 's' : ''} under the current account:\n\n` +
    `${lines || '—'}`;

  const viewRows = wallets.map(w => ([{
    text: `💳 View Wallet ${walletTag(w)}`,
    callback_data: `acct_view_${w.id}`,
  }]));

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🌟 Create Wallet',  callback_data: 'wl_gen'    },
        { text: '🌙 Import Wallet',  callback_data: 'wl_import' },
      ],
      [{ text: '😖 Delete Wallet', callback_data: 'acct_delete' }],
      ...viewRows,
      [{ text: '⬅️ Back', callback_data: 'close_msg' }],
    ],
  };

  const opts = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts)
      .catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}

// ─── Delete Wallet Selection ──────────────────────────────────────────────────
export async function showAccountDeletePage(ctx, telegramId, editMsgId = null) {
  const wallets = await getUserWallets(telegramId);

  let text =
    `🗑️ <b>Remove Wallet</b>\n\n` +
    `Remove a wallet from active use. Notifications and pending automated trades for it stop. Keep your own private-key backup.`;

  let rows;
  if (wallets.length <= 1) {
    text += `\n\n⚠️ You cannot delete your only wallet.`;
    rows = [];
  } else {
    rows = wallets.map(w => ([{
      text: `🗑 Delete Wallet ${walletTag(w)}${w.is_default ? ' ★' : ''}`,
      callback_data: `acct_delconfirm_${w.id}`,
    }]));
  }

  const keyboard = {
    inline_keyboard: [
      ...rows,
      [{ text: '⬅️ Back', callback_data: 'acct_main' }],
    ],
  };

  const opts = { parse_mode: 'HTML', reply_markup: keyboard };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts)
      .catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}

// ─── View Wallet Assets ───────────────────────────────────────────────────────
export async function showViewWallet(ctx, telegramId, walletId, editMsgId = null) {
  const w = await getWallet(telegramId, walletId);
  if (!w) return ctx.reply('❌ Wallet not found.');

  const tag = walletTag(w).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const [bnb, holdings] = await Promise.all([
    getBnbBalance(w.address).catch(() => 0),
    getWalletTokens(w.address).catch(() => []),
  ]);

  const tokenLines = holdings.map(h =>
    `• <b>${h.symbol}</b>: ${fmtAmt(h.formatted, h.symbol)} ` +
    `(<a href="https://bscscan.com/token/${h.ca}?a=${w.address}">view</a>)`
  );

  const tokenSection = tokenLines.length
    ? `\n\n<b>Tokens:</b>\n${tokenLines.join('\n')}`
    : '\n\n<i>No token holdings found.</i>';

  const text =
    `Network: BSC\n\n` +
    `💳 <b>Wallet ${tag}</b>\n` +
    `<a href="https://bscscan.com/address/${w.address}">${w.address}</a>\n` +
    `Balance: <b>${Number(bnb).toFixed(4)} BNB</b>\n` +
    `👆 <i>Click Token To Swap</i>` +
    tokenSection;

  const tokenButtons = holdings.slice(0, 8).map(h => ([{
    text: `🔄 ${h.symbol}`,
    callback_data: `bs_refresh_${h.ca}`,
  }]));

  const keyboard = {
    inline_keyboard: [
      [{ text: `✅ 💳 Wallet ${tag}`, callback_data: 'noop' }],
      ...tokenButtons,
      [{ text: '⬅️ Back to Account', callback_data: 'acct_main' }],
    ],
  };

  const opts = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts)
      .catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}
