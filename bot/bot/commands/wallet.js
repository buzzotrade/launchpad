import { ethers } from 'ethers';
import { walletLabel } from '../lib/walletLabel.js';
import {
  deriveUserWallet, getBnbBalance, encryptKey, decryptKey,
  seedHdWalletIfNeeded, getActiveWalletData, getWalletTokens,
} from '../lib/walletLib.js';
import {
  getUser, getUserWallets, getWallet, getDefaultWallet,
  countUserWallets, createWalletRecord, setDefaultWallet,
  toggleManualWallet, renameWallet, deleteWallet,
  getHiddenTokens, hideToken, unhideToken,
} from '../lib/db.js';

function fmtBnb(n) {
  if (n === 0) return '0 BNB';
  if (n >= 0.001) return `${n.toFixed(4)} BNB`;
  return `${n.toExponential(3)} BNB`;
}

function fmtToken(n, symbol) {
  let s;
  if (n >= 1_000_000) s = `${(n / 1_000_000).toFixed(2)}M`;
  else if (n >= 1)    s = n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  else if (n >= 0.01) s = n.toFixed(2);
  else                s = n.toExponential(2);
  return `${s} ${symbol}`;
}

// ─── /wallet command entry point ─────────────────────────────────────────────
export async function handleWallet(ctx) {
  const telegramId = ctx.from.id;
  try {
    const user = await getUser(telegramId);
    if (!user) return ctx.reply('Please use /start first.');
    await seedHdWalletIfNeeded(telegramId);
    await showWalletList(ctx, telegramId);
  } catch (e) {
    console.error('[/wallet]', e.message);
    await ctx.reply('❌ Error loading wallets. Try again.');
  }
}

// ─── Wallet list view ─────────────────────────────────────────────────────────
export async function showWalletList(ctx, telegramId, editMsgId = null) {
  const wallets = await getUserWallets(telegramId);
  const [balances, tokenLists] = await Promise.all([
    Promise.all(wallets.map(w => getBnbBalance(w.address).catch(() => 0))),
    Promise.all(wallets.map(w => getHiddenTokens(telegramId).then(h => getWalletTokens(w.address, [], h)).catch(() => []))),
  ]);

  const defWallet = wallets.find(w => w.is_default);

  let text = '🔗 <b>BSC — My Wallets</b>\n\n';
  for (let i = 0; i < wallets.length; i++) {
    const w      = wallets[i];
    const bal    = balances[i];
    const tokens = tokenLists[i];
    const def    = w.is_default ? '🟢 Default' : '🔴 Default';
    const man    = w.is_manual  ? '🟢 Manual'  : '🔴 Manual';
    const tokenLines = tokens.length
      ? tokens.map(t => `  • ${fmtToken(t.formatted, t.symbol)}`).join('\n')
      : '  • No tokens held';
    text +=
      `<a href="https://bscscan.com/address/${w.address}"><b>${walletLabel(w).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</b></a> (<code>${w.address}</code>)\n` +
      `${def} | ${man}\n` +
      `💰 ${fmtBnb(bal)}\n` +
      `${tokenLines}\n\n`;
  }

  text +=
    `ℹ️ <i>Enable "Manual" for swap wallets. Use the token panel arrows to select your Manual wallet. The 🟢 Default wallet stays separate for automated trades.</i>`;

  const rows = [];

  if (defWallet) {
    rows.push([{ text: `Default Wallet | ${walletLabel(defWallet)}`, callback_data: 'noop' }]);
  }

  for (const w of wallets) {
    rows.push([
      { text: `⚙️ ${walletLabel(w)}`,                            callback_data: `wl_view_${w.id}` },
      { text: w.is_manual ? '🟢 Manual' : '🔴 Manual',           callback_data: `wl_manual_${w.id}` },
      { text: w.is_default ? '🔒' : '❌',                        callback_data: w.is_default ? 'noop' : `wl_delask_${w.id}` },
    ]);
  }

  if (wallets.length < 10) {
    rows.push([
      { text: '📥 Import Wallet',   callback_data: 'wl_import' },
      { text: '🔑 Generate Wallet', callback_data: 'wl_gen'    },
    ]);
  } else {
    rows.push([{ text: '⚠️ Max 10 wallets reached', callback_data: 'noop' }]);
  }

  rows.push([
    { text: '💸 Sweep BNB → Default',   callback_data: 'sweep_bnb'       },
    { text: '🔁 Sweep Token → Default', callback_data: 'sweep_token_ask' },
  ]);

  rows.push([{ text: '⬅️ Back', callback_data: 'menu_main' }]);

  const opts = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows },
  };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts)
      .catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}

// ─── Single wallet detail view ────────────────────────────────────────────────
export async function showWalletDetail(ctx, telegramId, walletId, editMsgId = null) {
  const w = await getWallet(telegramId, walletId);
  if (!w) return ctx.reply('❌ Wallet not found.');

  const [bal, tokens, hiddenCAs] = await Promise.all([
    getBnbBalance(w.address).catch(() => 0),
    getHiddenTokens(telegramId).then(h => getWalletTokens(w.address, [], h)).catch(() => []),
    getHiddenTokens(telegramId).catch(() => []),
  ]);
  const def = w.is_default ? '🟢 Default' : '🔴 Default';
  const man = w.is_manual  ? '🟢 Manual'  : '🔴 Manual';

  const tokenSection = tokens.length
    ? tokens.map(t =>
        `  • <code>${t.ca}</code>\n    ${fmtToken(t.formatted, t.symbol)}`
      ).join('\n')
    : '  • No tokens held';

  const text =
    `🔗 <b>BSC — ${w.name}</b>\n\n` +
    `<a href="https://bscscan.com/address/${w.address}">${w.name}</a> (<code>${w.address}</code>)\n` +
    `${def} | ${man}\n\n` +
    `💰 <b>BNB:</b> ${fmtBnb(bal)}\n` +
    `🪙 <b>Tokens:</b>\n${tokenSection}\n\n` +
    `ℹ️ <i>Enable "Manual" for wallets participating in manual buys. Automated buys use the 🟢 Default wallet.</i>`;

  // Per-token hide buttons — one row per token
  const tokenRows = tokens.map(t => ([
    { text: `🙈 Hide ${t.symbol}`, callback_data: `wl_hide_${w.id}_${t.ca}` },
    { text: `💱 Sell ${t.symbol}`, callback_data: `bs_load_${t.ca}` },
  ]));

  const rows = [
    ...tokenRows,
    [{ text: 'Trading Setup', callback_data: `ts_view_${w.id}` }],
    [
      { text: '⬅️ Back',   callback_data: 'wl_list' },
      { text: '✏️ Rename', callback_data: `wl_rename_${w.id}` },
    ],
    [
      {
        text: w.is_default ? '🟢 Default (active)' : '🔴 Set as Default',
        callback_data: w.is_default ? 'noop' : `wl_default_${w.id}`,
      },
      {
        text: w.is_manual ? '🟢 Manual ON' : '🔴 Manual OFF',
        callback_data: `wl_manual_${w.id}`,
      },
    ],
    [
      { text: '💸 Send BNB', callback_data: `wl_sendb_${w.id}` },
      { text: '🔑 Export Key', callback_data: `wl_export_${w.id}` },
    ],
    [
      { text: '🗑️ Remove Wallet', callback_data: `wl_delask_${w.id}` },
    ],
  ];

  const opts = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows },
  };

  if (editMsgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, editMsgId, null, text, opts)
      .catch(() => ctx.reply(text, opts));
  }
  return ctx.reply(text, opts);
}

// ─── Export private key (ephemeral message) ───────────────────────────────────
export async function handleExportKey(ctx) {
  const telegramId = ctx.from.id;
  try {
    const w = await getActiveWalletData(telegramId);
    const m = await ctx.reply(
      `🔑 <b>Private Key — ${w.name || 'Your Wallet'}</b>\n\n` +
      `<tg-spoiler>${w.privateKey}</tg-spoiler>\n\n` +
      `⚠️ <b>NEVER share this with anyone.</b>\n` +
      `Import into MetaMask or any EVM wallet.\n\n` +
      `<i>⏱ This message auto-deletes in 60 seconds.</i>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {});
    }, 60_000);
  } catch (e) {
    await ctx.reply('❌ Error exporting key.');
  }
}
