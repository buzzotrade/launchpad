import { Telegraf } from 'telegraf';
import { handleStart, mainMenu } from './commands/start.js';
import { handleWallet, handleExportKey, showWalletList, showWalletDetail } from './commands/wallet.js';
import { handleScan, doScan, buildScanText } from './commands/scan.js';
import { handleNew } from './commands/new.js';
import { handleBuy, handleConfirmBuy } from './commands/buy.js';
import { handleSell } from './commands/sell.js';
import { handleHistory } from './commands/history.js';
import { handleTrending } from './commands/trending.js';
import { handleRecentBond } from './commands/recentbond.js';
import { handleNewCreated, handleNewCreatedStop, handleNewCreatedResume, stopNewCreatedWatcher } from './commands/newcreated.js';
import { handleSnipe, doSnipe } from './commands/snipe.js';
import { handleAlert, setAlertForCA } from './commands/alert.js';
import { handleCancel } from './commands/cancel.js';
import { handleHelp } from './commands/help.js';
import { showTokenPanel, executeBuy, executeSell, slippagePanel, gasPanel, switchPanelMode } from './commands/buysell.js';
import { handleSettings, showGlobalTradeSettings, gasPickerKeyboard } from './commands/settings.js';
import { getActiveWalletData, getBnbBalance, encryptKey, decryptKey, sendBnb } from './lib/walletLib.js';
import { ethers } from 'ethers';
import {
  getUser, updateSlippage, updateAntiMev, updateGasMode, updateUserSetting, createLimitOrder,
  getUserWallets, getWallet, countUserWallets, createWalletRecord,
  setDefaultWallet, toggleManualWallet, renameWallet, deleteWallet, isWalletNameTaken,
  wasAddressPreviouslyUsedByUser,
  setCustomBuySlot, setCustomSellSlot, getCustomBuys, getCustomSells,
  getAutoSellRules, createAutoSellRule, toggleAutoSellRule, deleteAutoSellRule, setUserAutoSell,
  getUserLanguage, setUserLanguage,
} from './lib/db.js';
import { t } from './lib/i18n.js';
import { showLanguagePicker, handleSetLanguage } from './commands/language.js';
import {
  handleLimitCommand, showLimitOrdersList, handleCancelLimitOrder, handleCancelAllLimitOrders,
  parseTriggerPrice, promptTriggerPrice, confirmLimitOrder,
} from './commands/limit.js';
import { showAccountPage, showAccountDeletePage, showViewWallet } from './commands/account.js';
import { showAutoSellPage, showAddRulePage } from './commands/autosell.js';
import { showReceivePage, showReceiveQR } from './commands/receive.js';
import { showReferralPage, showPromoDetails, handleClaimReward, showClaimRecords } from './commands/referral.js';
import { showCommandsPage } from './commands/commands.js';
import { startDepositMonitor } from './monitor.js';
import { handleTip } from './commands/tip.js';

// ─── Per-user rate limiter ────────────────────────────────────────────────────
const rateLimitMap = new Map(); // telegramId -> { count, resetAt }
const RATE_LIMIT = 25;          // max actions per window
const RATE_WINDOW = 10_000;     // 10 seconds
function isRateLimited(telegramId) {
  const now = Date.now();
  let entry = rateLimitMap.get(telegramId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimitMap.set(telegramId, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of rateLimitMap) if (now > e.resetAt) rateLimitMap.delete(id);
}, 60_000);

// In-memory state: telegramId -> { mode, ca?, msgId? }
const userState = new Map();

// PK message tracking — auto-delete after 60s or on next user action
const pkMessages = new Map(); // telegramId -> { chatId, msgId, timer, telegram }

// Panel mode tracking — remember whether user was on swap or limit tab
const panelModeStore = new Map(); // telegramId -> { ca, mode: 'swap'|'limit' }

function setPanelMode(tid, ca, mode) { panelModeStore.set(tid, { ca, mode }); }
function getPanelMode(tid) { return panelModeStore.get(tid) || { ca: null, mode: 'swap' }; }

function trackPkMsg(tid, chatId, msgId, telegram) {
  const prev = pkMessages.get(tid);
  if (prev) {
    clearTimeout(prev.timer);
    prev.telegram.deleteMessage(prev.chatId, prev.msgId).catch(() => {});
  }
  const timer = setTimeout(() => {
    telegram.deleteMessage(chatId, msgId).catch(() => {});
    pkMessages.delete(tid);
  }, 60 * 1000);
  pkMessages.set(tid, { chatId, msgId, timer, telegram });
}

function clearPkMsg(tid, telegram) {
  const prev = pkMessages.get(tid);
  if (!prev) return;
  clearTimeout(prev.timer);
  (telegram || prev.telegram).deleteMessage(prev.chatId, prev.msgId).catch(() => {});
  pkMessages.delete(tid);
}

const IS_CA = /^0x[0-9a-fA-F]{40}$/;

export function createBot() {
  const token = process.env.BUZZO_BOT_TOKEN;
  if (!token) throw new Error('BUZZO_BOT_TOKEN not set');

  const bot = new Telegraf(token);

  // Rate limiter + stop watcher middleware
  bot.use((ctx, next) => {
    const telegramId = ctx.from?.id;
    if (telegramId && isRateLimited(telegramId)) return; // silently drop
    if (ctx.message && ctx.chat) stopNewCreatedWatcher(ctx.chat.id);
    return next();
  });

  // Group guard — only /tip is allowed in groups; all other commands redirect to DM
  bot.use(async (ctx, next) => {
    const chatType = ctx.chat?.type;
    const isGroupChat = chatType === 'group' || chatType === 'supergroup' || chatType === 'channel';
    if (!isGroupChat) return next();

    const text = ctx.message?.text || '';
    const isCommand = text.startsWith('/');
    if (!isCommand) return next(); // allow non-command messages (needed for tip flow)

    // Strip bot mention to get the bare command
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/tip') return next(); // tip is the only group-allowed command

    // All other commands → redirect to private chat (auto-delete after 30s)
    const botUsername = ctx.botInfo?.username || 'Buzzotrade_bot';
    const m = await ctx.reply(
      `🔒 Please use this command in private chat with the bot.\n👉 @${botUsername}`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => null);
    if (m) {
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {});
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }, 8_000);
    }
    return; // stop processing
  });

  // Commands
  bot.start(handleStart);
  bot.command('wallet', handleWallet);
  bot.command('exportkey', handleExportKey);
  bot.command('scan', handleScan);
  bot.command('new', handleNew);
  bot.command('buy', handleBuy);
  bot.command('sell', handleSell);
  bot.command('snipe', handleSnipe);
  bot.command('alert', handleAlert);
  bot.command('cancel', handleCancel);
  bot.command('help', handleHelp);
  bot.command('settings', handleSettings);
  bot.command('limit',      handleLimitCommand);
  bot.command('limitorder', handleLimitCommand);
  bot.command('history',    handleHistory);
  bot.command('tip',        handleTip);
  bot.command('trending',   handleTrending);
  bot.command('recentbond', handleRecentBond);
  bot.command('newcreated', handleNewCreated);
  bot.command('referral', async (ctx) => showReferralPage(ctx, ctx.from.id));
  bot.command('commands', async (ctx) => showCommandsPage(ctx));

  bot.command('clean', async (ctx) => {
    const telegramId = ctx.from.id;
    userState.delete(telegramId);
    await setUserLanguage(telegramId, 'en');
    await ctx.reply('🔄 Language reset to English.\n\n/start to refresh your dashboard.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Start', callback_data: 'menu_main' }]] },
    });
  });

  // Text messages — handle state machine + legacy confirmbuy
  bot.on('text', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const text = ctx.message.text.trim();
    const tid = ctx.from.id;
    const state = userState.get(tid);
    clearPkMsg(tid, ctx.telegram);

    // Persistent "Menu" button
    if (text === '📋 Menu') {
      return handleStart(ctx);
    }

    // Legacy confirmbuy
    if (/^\/confirmbuy_/.test(text)) {
      return handleConfirmBuy(ctx);
    }

    // Awaiting CA for Buy/Sell
    if (state?.mode === 'awaiting_ca') {
      const lang = state.lang || 'en';
      if (IS_CA.test(text)) {
        userState.delete(tid);
        if (state.msgId) {
          ctx.telegram.deleteMessage(ctx.chat.id, state.msgId).catch(() => {});
        }
        setPanelMode(tid, text, 'swap');
        return showTokenPanel(ctx, text);
      } else {
        return ctx.reply(t(lang, 'err_invalid_ca'));
      }
    }

    // Awaiting custom BNB amount
    if (state?.mode === 'awaiting_buy_amount') {
      const amt = parseFloat(text);
      if (!isNaN(amt) && amt > 0) {
        userState.delete(tid);
        return executeBuy(ctx, state.ca, amt);
      } else {
        return ctx.reply('❌ Invalid amount. Enter a number like 0.1');
      }
    }

    // Awaiting custom sell percent
    if (state?.mode === 'awaiting_sell_percent') {
      const pct = parseInt(text);
      if (!isNaN(pct) && pct >= 1 && pct <= 100) {
        userState.delete(tid);
        return executeSell(ctx, state.ca, pct);
      } else {
        return ctx.reply('❌ Invalid percent. Enter a number 1–100.');
      }
    }

    // Awaiting CA for Scan (button flow)
    if (state?.mode === 'awaiting_scan_ca') {
      if (state.msgId) ctx.telegram.deleteMessage(ctx.chat.id, state.msgId).catch(() => {});
      const lang = state.lang || 'en';
      if (IS_CA.test(text)) {
        userState.delete(tid);
        return doScan(ctx, text);
      } else {
        return ctx.reply(t(lang, 'err_invalid_ca'));
      }
    }

    // Awaiting CA for Snipe (button flow)
    if (state?.mode === 'awaiting_snipe_ca') {
      const lang = state.lang || 'en';
      if (IS_CA.test(text)) {
        const prompt = await ctx.reply(
          `🎯 Token: \`${text}\`\n\n${t(lang, 'prompt_snipe_bnb')}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_cancel_action'), callback_data: 'close_msg' }]] } }
        );
        userState.set(tid, { mode: 'awaiting_snipe_amount', ca: text, lang, msgId: prompt.message_id });
      } else {
        return ctx.reply(t(lang, 'err_invalid_ca'));
      }
      return;
    }

    // Awaiting BNB amount for Snipe (button flow)
    if (state?.mode === 'awaiting_snipe_amount') {
      if (state.msgId) ctx.telegram.deleteMessage(ctx.chat.id, state.msgId).catch(() => {});
      const lang = state.lang || 'en';
      const bnbAmount = parseFloat(text);
      if (isNaN(bnbAmount) || bnbAmount <= 0) {
        return ctx.reply('❌ Invalid amount. Enter a number like 0.1');
      }
      userState.delete(tid);
      return doSnipe(ctx, tid, state.ca, bnbAmount);
    }

    // Awaiting CA for Alert (button flow)
    if (state?.mode === 'awaiting_alert_ca') {
      const lang = state.lang || 'en';
      if (IS_CA.test(text)) {
        const prompt = await ctx.reply(
          `🔔 Token: \`${text}\`\n\n${t(lang, 'prompt_alert_mul')}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_cancel_action'), callback_data: 'close_msg' }]] } }
        );
        userState.set(tid, { mode: 'awaiting_alert_multiplier', ca: text, lang, msgId: prompt.message_id });
      } else {
        return ctx.reply(t(lang, 'err_invalid_ca'));
      }
      return;
    }

    // Awaiting multiplier for Alert (button flow)
    if (state?.mode === 'awaiting_alert_multiplier') {
      if (state.msgId) ctx.telegram.deleteMessage(ctx.chat.id, state.msgId).catch(() => {});
      userState.delete(tid);
      return setAlertForCA(ctx, tid, state.ca, text.trim());
    }

    // Awaiting a global settings value
    if (state?.mode === 'awaiting_setting_value') {
      const key  = state.settingKey;
      const val  = text.trim();
      const num  = parseFloat(val);

      let valid = false;
      let saved = null;

      if (key === 'slippage') {
        if (!isNaN(num) && num >= 0 && num <= 100) { saved = num; valid = true; }
        else return ctx.reply('❌ Enter a number 0–100 (0 = Auto).');
      } else if (key === 'gas_mode') {
        if (!isNaN(num) && num > 0) { saved = String(num); valid = true; }
        else return ctx.reply('❌ Enter a positive GWEI number, e.g. 5.');
      } else if (['pre_approve_gas', 'transfer_gas', 'sniper_gas'].includes(key)) {
        if (!isNaN(num) && num >= 0) { saved = num; valid = true; }
        else return ctx.reply('❌ Enter a valid GWEI number, e.g. 0.05.');
      } else if (key === 'sniper_slippage') {
        if (!isNaN(num) && num > 0 && num <= 100) { saved = num; valid = true; }
        else return ctx.reply('❌ Enter a % between 1–100.');
      } else if (key === 'snipe_min_liq') {
        if (!isNaN(num) && num >= 0) { saved = num; valid = true; }
        else return ctx.reply('❌ Enter BNB amount, e.g. 0.05.');
      }

      if (valid) {
        userState.delete(tid);
        await updateUserSetting(tid, key, saved);
        await ctx.reply(`✅ Setting saved.`);
        return showGlobalTradeSettings(ctx);
      }
    }

    // ── Wallet management state handlers ──────────────────────
    if (state?.mode === 'awaiting_wallet_gen_count') {
      const n = parseInt(text.trim());
      const count = await countUserWallets(tid);
      const available = 10 - count;
      if (isNaN(n) || n < 1 || n > available) {
        return ctx.reply(`❌ Please enter a number between 1 and ${available}.`);
      }
      userState.delete(tid);
      const existing = await getUserWallets(tid);
      const usedNames = new Set(existing.map(w => w.name.toLowerCase()));
      const results = [];
      let idx = count + 1;
      for (let i = 0; i < n; i++) {
        let w;
        let attempts = 0;
        do {
          w = ethers.Wallet.createRandom();
          attempts++;
        } while (attempts < 10 && await wasAddressPreviouslyUsedByUser(tid, w.address));
        let name;
        do { name = `Wallet ${idx++}`; } while (usedNames.has(name.toLowerCase()));
        usedNames.add(name.toLowerCase());
        const encPk = encryptKey(w.privateKey);
        await createWalletRecord(tid, name, w.address, encPk, 'generated', false);
        results.push({ name, address: w.address });
      }
      const lines = results.map(r => `• <b>${r.name}</b>\n  <code>${r.address}</code>`).join('\n');
      await ctx.reply(
        `✅ <b>${n} wallet${n > 1 ? 's' : ''} generated!</b>\n\n${lines}`,
        { parse_mode: 'HTML' }
      );
      return showWalletList(ctx, tid);
    }

    if (state?.mode === 'awaiting_wallet_name') {
      const name = text.trim().slice(0, 30);
      if (!name) return ctx.reply('❌ Name cannot be empty.');
      if (await isWalletNameTaken(tid, name)) return ctx.reply('❌ That name is already used. Choose a different name.');
      userState.delete(tid);
      const { pendingPk, pendingAddress, pendingType } = state;
      const count = await countUserWallets(tid);
      if (count >= 10) return ctx.reply('❌ Maximum 10 wallets reached.');
      const encPk = encryptKey(pendingPk);
      await createWalletRecord(tid, name, pendingAddress, encPk, pendingType, false);
      await ctx.reply(
        `✅ <b>Wallet "${name}" added!</b>\n\n<code>${pendingAddress}</code>\n\nUse /wallet to view and manage your wallets.`,
        { parse_mode: 'HTML' }
      );
      return showWalletList(ctx, tid);
    }

    if (state?.mode === 'awaiting_import_pk') {
      const raw = text.trim();
      userState.delete(tid);
      await ctx.deleteMessage().catch(() => {});
      let w;
      try {
        const pk = raw.startsWith('0x') ? raw : '0x' + raw;
        w = new ethers.Wallet(pk);
      } catch {
        return ctx.reply('❌ Invalid private key. Please send a valid EVM private key.');
      }
      const count = await countUserWallets(tid);
      if (count >= 10) return ctx.reply('❌ Maximum 10 wallets reached.');
      userState.set(tid, { mode: 'awaiting_wallet_name', pendingPk: w.privateKey, pendingAddress: w.address, pendingType: 'imported' });
      return ctx.reply(`✅ Valid key for <code>${w.address}</code>\n\nNow enter a name for this wallet (e.g. "Main" or "Trader"):`, { parse_mode: 'HTML' });
    }

    if (state?.mode === 'awaiting_wallet_rename') {
      const name = text.trim().slice(0, 30);
      if (!name) return ctx.reply('❌ Name cannot be empty.');
      if (await isWalletNameTaken(tid, name, state.walletId)) return ctx.reply('❌ That name is already used. Choose a different name.');
      userState.delete(tid);
      await renameWallet(tid, state.walletId, name);
      await ctx.answerCbQuery?.('').catch(() => {});
      await ctx.reply(`✅ Wallet renamed to "${name}".`);
      return showWalletDetail(ctx, tid, state.walletId);
    }

    if (state?.mode === 'awaiting_send_bnb_to') {
      const addr = text.trim();
      if (!ethers.isAddress(addr)) return ctx.reply('❌ Invalid address. Enter a valid BSC address (0x...).');
      userState.set(tid, { mode: 'awaiting_send_bnb_amount', walletId: state.walletId, toAddress: addr });
      return ctx.reply(`Recipient: <code>${addr}</code>\n\nNow enter the BNB amount to send (e.g. 0.1):`, { parse_mode: 'HTML' });
    }

    if (state?.mode === 'awaiting_send_bnb_amount') {
      const amt = parseFloat(text.trim());
      if (isNaN(amt) || amt <= 0) return ctx.reply('❌ Invalid amount. Enter a positive number like 0.1.');
      userState.delete(tid);
      const w = await getWallet(tid, state.walletId);
      if (!w) return ctx.reply('❌ Wallet not found.');
      const pk = decryptKey(w.encrypted_pk);
      const msg = await ctx.reply(`🔄 Sending ${amt} BNB to ${state.toAddress}...`);
      try {
        const txHash = await sendBnb(pk, state.toAddress, amt);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `✅ <b>Sent ${amt} BNB!</b>\n\n<a href="https://bscscan.com/tx/${txHash}">View on BscScan</a>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `wl_view_${w.id}` }]] } }
        );
      } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Send failed: ${e.message}`);
      }
      return;
    }

    // ── Limit order state handlers ─────────────────────────
    if (state?.mode === 'awaiting_limit_custom_buy') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) return ctx.reply('❌ Invalid amount. Enter a positive number like 0.5');
      userState.set(tid, { mode: 'awaiting_limit_trigger', ca: state.ca, side: 'buy', amount: amt, currentPrice: state.currentPrice });
      return promptTriggerPrice(ctx, state.ca, 'buy', amt, state.currentPrice);
    }

    if (state?.mode === 'awaiting_limit_custom_sell') {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct < 1 || pct > 100) return ctx.reply('❌ Invalid percent. Enter a number 1–100.');
      userState.set(tid, { mode: 'awaiting_limit_trigger', ca: state.ca, side: 'sell', amount: pct, currentPrice: state.currentPrice });
      return promptTriggerPrice(ctx, state.ca, 'sell', pct, state.currentPrice);
    }

    if (state?.mode === 'awaiting_limit_trigger') {
      const triggerPrice = parseTriggerPrice(text, state.currentPrice);
      if (!triggerPrice) {
        return ctx.reply(
          '❌ Invalid input. Use:\n• % change: <code>-5%</code> or <code>+10%</code>\n• Specific price: <code>0.00041</code> or <code>$0.00041</code>',
          { parse_mode: 'HTML' }
        );
      }
      userState.delete(tid);
      const order = await createLimitOrder(tid, state.ca, state.side, state.amount, triggerPrice, text);
      return confirmLimitOrder(ctx, order, triggerPrice, state.currentPrice, text, state.ca);
    }

    // ── Custom buy slot input ─────────────────────────────────
    if (state?.mode === 'awaiting_custom_buy') {
      const val = parseFloat(text);
      userState.delete(tid);
      if (isNaN(val) || val < 0) return ctx.reply('❌ Invalid amount. Enter a positive number or 0 to clear.');
      await setCustomBuySlot(tid, state.slot, val === 0 ? null : val);
      return showGlobalTradeSettings(ctx);
    }

    // ── Custom sell slot input ────────────────────────────────
    if (state?.mode === 'awaiting_custom_sell') {
      const val = parseFloat(text);
      userState.delete(tid);
      if (isNaN(val) || val < 0 || val > 100) return ctx.reply('❌ Invalid percentage. Enter 1–100 or 0 to clear.');
      await setCustomSellSlot(tid, state.slot, val === 0 ? null : val);
      return showGlobalTradeSettings(ctx);
    }

    // ── Auto sell rule — trigger pct input ────────────────────
    if (state?.mode === 'awaiting_autosell_trigger') {
      const val = parseFloat(text);
      if (isNaN(val) || val === 0) return ctx.reply('❌ Enter a non-zero number (e.g. 50 for +50%, or 50 for trailing %).');
      const isSl = state.ruleType === 'sl';
      const isTrailing = state.ruleType === 'trailing';
      const triggerPct = isSl ? -Math.abs(val) : Math.abs(val);
      userState.set(tid, { mode: 'awaiting_autosell_sell_pct', triggerPct, trailing: isTrailing ? 1 : 0 });
      return ctx.reply(
        `✏️ Now enter the <b>sell percentage</b> (1–100) when this rule triggers:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cfg_autosell' }]] } }
      );
    }

    // ── Auto sell rule — sell pct input ───────────────────────
    if (state?.mode === 'awaiting_autosell_sell_pct') {
      const val = parseFloat(text);
      if (isNaN(val) || val < 1 || val > 100) return ctx.reply('❌ Invalid. Enter 1–100.');
      userState.delete(tid);
      await createAutoSellRule(tid, state.triggerPct, val, state.trailing);
      await ctx.reply('✅ Auto sell rule created.');
      return showAutoSellPage(ctx, tid);
    }

    // Awaiting custom gas GWEI
    if (state?.mode === 'awaiting_gas_gwei') {
      const val = parseFloat(text);
      if (!isNaN(val) && val > 0) {
        const savedMsgId = state.msgId;
        const savedCa    = state.ca;
        userState.delete(tid);
        const { mode: pm } = getPanelMode(tid);
        const gasKey = pm === 'limit' ? 'limit_gas_mode' : 'swap_gas_mode';
        await updateUserSetting(tid, gasKey, String(val));
        await ctx.deleteMessage().catch(() => {});
        return showTokenPanel(ctx, savedCa, savedMsgId, pm);
      } else {
        return ctx.reply('❌ Invalid GWEI value. Enter a positive number like 5.');
      }
    }

    // Awaiting slippage — edit the stored panel message back to token view
    if (state?.mode === 'awaiting_slippage') {
      const val = parseFloat(text);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        userState.delete(tid);
        const { mode: pm } = getPanelMode(tid);
        const slipKey = pm === 'limit' ? 'limit_slippage' : 'swap_slippage';
        await updateUserSetting(tid, slipKey, val);
        await ctx.deleteMessage().catch(() => {});
        return showTokenPanel(ctx, state.ca, state.msgId, pm);
      } else {
        return ctx.reply('❌ Invalid slippage. Enter 0–100 (0 = Auto 10%).');
      }
    }

    // Auto-detect CA pasted directly
    if (IS_CA.test(text)) {
      setPanelMode(tid, text, 'swap');
      return showTokenPanel(ctx, text);
    }
  });

  // Inline keyboard callbacks
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const tid = ctx.from.id;
    await ctx.answerCbQuery().catch(() => {});
    clearPkMsg(tid, ctx.telegram);

    // ── Main menu ──────────────────────────────────────────
    if (data === 'noop') return;

    if (data === 'menu_chain') {
      return ctx.answerCbQuery('BNB Smart Chain (BSC) — BEP-20 tokens only', { show_alert: true });
    }

    if (data === 'menu_buysell') {
      const lang = await getUserLanguage(tid);
      const prompt = await ctx.reply(
        t(lang, 'prompt_buysell'),
        { reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_back'), callback_data: 'menu_back' }]] } }
      );
      userState.set(tid, { mode: 'awaiting_ca', lang, msgId: prompt.message_id });
      return;
    }

    if (data === 'menu_back') {
      userState.delete(tid);
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data === 'menu_wallet') {
      return handleWallet(ctx);
    }

    if (data === 'menu_account' || data === 'acct_main') {
      const msgId = ctx.callbackQuery?.message?.message_id || null;
      return showAccountPage(ctx, tid, data === 'acct_main' ? msgId : null);
    }

    if (data === 'acct_delete') {
      const msgId = ctx.callbackQuery?.message?.message_id;
      return showAccountDeletePage(ctx, tid, msgId);
    }

    if (data.startsWith('acct_view_')) {
      const walletId = parseInt(data.replace('acct_view_', ''));
      const msgId = ctx.callbackQuery?.message?.message_id;
      return showViewWallet(ctx, tid, walletId, msgId);
    }

    if (data.startsWith('acct_delconfirm_')) {
      const walletId = parseInt(data.replace('acct_delconfirm_', ''));
      const wallet  = await getWallet(tid, walletId);
      if (!wallet) return ctx.answerCbQuery('Wallet not found.', { show_alert: true });
      const allWallets = await getUserWallets(tid);
      if (allWallets.length <= 1) {
        return ctx.answerCbQuery('⚠️ Cannot delete your only wallet.', { show_alert: true });
      }
      if (wallet.is_default) {
        const next = allWallets.find(w => w.id !== walletId);
        if (next) await setDefaultWallet(tid, next.id);
      }
      await deleteWallet(tid, walletId);
      await ctx.answerCbQuery('✅ Wallet deleted.', { show_alert: true });
      const msgId = ctx.callbackQuery?.message?.message_id;
      return showAccountPage(ctx, tid, msgId);
    }

    if (data === 'menu_language') {
      const lang = await getUserLanguage(tid);
      return showLanguagePicker(ctx, lang);
    }

    if (data.startsWith('set_lang_')) {
      const newLang = data.replace('set_lang_', '');
      const lang = await getUserLanguage(tid);
      return handleSetLanguage(ctx, tid, newLang, lang);
    }

    if (data === 'menu_snipe') {
      const lang = await getUserLanguage(tid);
      const prompt = await ctx.reply(
        t(lang, 'prompt_snipe_ca'),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_cancel_action'), callback_data: 'close_msg' }]] } }
      );
      userState.set(tid, { mode: 'awaiting_snipe_ca', lang, msgId: prompt.message_id });
      return;
    }

    if (data === 'menu_alert') {
      const lang = await getUserLanguage(tid);
      const prompt = await ctx.reply(
        t(lang, 'prompt_alert_ca'),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_cancel_action'), callback_data: 'close_msg' }]] } }
      );
      userState.set(tid, { mode: 'awaiting_alert_ca', lang, msgId: prompt.message_id });
      return;
    }

    if (data === 'menu_scan') {
      const lang = await getUserLanguage(tid);
      const prompt = await ctx.reply(
        t(lang, 'prompt_scan'),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_cancel_action'), callback_data: 'close_msg' }]] } }
      );
      userState.set(tid, { mode: 'awaiting_scan_ca', lang, msgId: prompt.message_id });
      return;
    }

    if (data === 'menu_receive') {
      const msgId = ctx.callbackQuery?.message?.message_id;
      return showReceivePage(ctx, tid, msgId);
    }

    if (data === 'menu_tip') {
      return ctx.reply(
        '💸 <b>Tip tokens to another user</b>\n\n' +
        '<b>Syntax:</b>\n' +
        '<code>/tip &lt;amount&gt; [token] [@username]</code>\n\n' +
        '<b>Examples:</b>\n' +
        '• <code>/tip 0.001 BNB</code> — 0.001 BNB (reply to target)\n' +
        '• <code>/tip 0.001 BNB @username</code> — 0.001 BNB to @username\n' +
        '• <code>/tip 1 BNB @aamon</code> — 1 BNB\n' +
        '• <code>/tip 10 USDT @aamon</code> — 10 USDT\n' +
        '• <code>/tip 100 0x1234...abcd @aamon</code> — any token by CA\n\n' +
        '<b>Supported tokens:</b> BNB (default until BUZZO is configured), BUZZO, USDT, USDC, BUSD, WBNB, CAKE\n\n' +
        '• In groups: reply to a message instead of @username\n' +
        '• No admin rights needed\n' +
        '• ERC20 tips are held if recipient hasn\'t joined yet',
        { parse_mode: 'HTML' }
      );
    }

    if (data.startsWith('receive_qr_')) {
      const walletId = parseInt(data.replace('receive_qr_', ''));
      return showReceiveQR(ctx, tid, walletId);
    }

    if (data === 'close_msg') {
      userState.delete(tid);
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    // Scan button callbacks
    if (data === 'scan_del') {
      await ctx.deleteMessage().catch(() => {});
      return;
    }
    if (data.startsWith('scan_ref_')) {
      const ca = data.slice(9);
      await ctx.deleteMessage().catch(() => {});
      return doScan(ctx, ca);
    }
    if (data.startsWith('scan_buy_')) {
      const ca = data.slice(9);
      await ctx.answerCbQuery().catch(() => {});
      return showTokenPanel(ctx, ca, null, 'buy').catch(() => {});
    }

    if (data === 'menu_new')      return handleNew(ctx);
    if (data === 'menu_cancel')   { stopNewCreatedWatcher(ctx.chat.id); return handleCancel(ctx); }
    if (data === 'menu_help')     return handleHelp(ctx);
    if (data === 'menu_history')     return handleHistory(ctx);
    if (data === 'menu_trending')    return handleTrending(ctx, ctx.callbackQuery.message?.message_id);
    if (data === 'menu_limit')       return handleLimitCommand(ctx);
    if (data === 'menu_recentbond')  return handleRecentBond(ctx);
    if (data === 'menu_newcreated')  return handleNewCreated(ctx);
    if (data === 'newcreated_stop')  return handleNewCreatedStop(ctx);
    if (data === 'newcreated_resume') return handleNewCreatedResume(ctx);
    if (data === 'menu_main') return handleStart(ctx);
    if (data === 'menu_commands') return showCommandsPage(ctx);

    // ── Referral ────────────────────────────────────────────
    if (data === 'ref_main')    return showReferralPage(ctx, tid);
    if (data === 'ref_promo')   return showPromoDetails(ctx);
    if (data === 'ref_claim')   return handleClaimReward(ctx, tid);
    if (data === 'ref_records') return showClaimRecords(ctx, tid);

    // ── Settings panel ─────────────────────────────────────
    if (data === 'cfg_global') return showGlobalTradeSettings(ctx);
    if (data === 'cfg_back')   return handleSettings(ctx);
    if (data === 'cfg_close')  return ctx.deleteMessage().catch(() => {});
    if (data === 'cfg_chain_info') {
      return ctx.answerCbQuery('BNB Smart Chain (BSC) — BEP-20 tokens only', { show_alert: true });
    }

    // Settings: Swap Gas Fee → show inline gas picker
    if (data === 'cfg_set_gas') {
      userState.set(tid, { mode: 'awaiting_setting_value', settingKey: 'gas_mode' });
      const user = await getUser(tid);
      const gm = user?.gas_mode || 'medium';
      const curLabel = gm === 'medium' ? '🐢 Medium' : gm === 'fast' ? '🐴 Fast' : gm === 'turbo' ? '🐋 Turbo' : `${gm} GWEI`;
      return ctx.reply(
        `Select Swap Gas Fee\nCurrent: ${curLabel}\n\nOr type a custom GWEI value (e.g. 5):`,
        { reply_markup: gasPickerKeyboard() }
      );
    }

    // Settings: Gas preset buttons (from settings gas picker)
    if (data === 'cfg_gas_medium' || data === 'cfg_gas_fast' || data === 'cfg_gas_turbo') {
      userState.delete(tid);
      const mode = data.replace('cfg_gas_', '');
      await updateUserSetting(tid, 'gas_mode', mode);
      const label = mode === 'medium' ? '🐢 Medium' : mode === 'fast' ? '🐴 Fast' : '🐋 Turbo';
      await ctx.answerCbQuery(`✅ Swap Gas set to ${label}`, { show_alert: true });
      await ctx.deleteMessage().catch(() => {});
      return showGlobalTradeSettings(ctx);
    }

    if (data === 'cfg_gas_close') {
      userState.delete(tid);
      return ctx.deleteMessage().catch(() => {});
    }

    // Settings: all other edit buttons — prompt for value
    const SETTING_PROMPTS = {
      cfg_set_slippage:         { key: 'slippage',        msg: 'Enter Swap Slippage % (0 = Auto, max 100):' },
      cfg_set_pre_approve_gas:  { key: 'pre_approve_gas', msg: 'Enter Pre-Approve Extra Gas in GWEI (e.g. 0.05):' },
      cfg_set_transfer_gas:     { key: 'transfer_gas',    msg: 'Enter Transfer Extra Gas in GWEI (e.g. 0.05):' },
      cfg_set_sniper_slippage:  { key: 'sniper_slippage', msg: 'Enter Sniper Slippage % (e.g. 50):' },
      cfg_set_sniper_gas:       { key: 'sniper_gas',      msg: 'Enter Sniper Gas Fee in GWEI (e.g. 3):' },
      cfg_set_snipe_min_liq:    { key: 'snipe_min_liq',   msg: 'Enter Snipe Min Liquidity in BNB (e.g. 0.05):' },
    };
    if (SETTING_PROMPTS[data]) {
      const { key, msg } = SETTING_PROMPTS[data];
      userState.set(tid, { mode: 'awaiting_setting_value', settingKey: key });
      return ctx.reply(msg, {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cfg_close' }]] },
      });
    }

    // ── Token panel callbacks ──────────────────────────────

    // Wallet info button (💳 Wallet XXXX)
    if (data.startsWith('wallet_info_')) {
      const ca     = data.replace('wallet_info_', '');
      const wallet = await getActiveWalletData(tid);
      const bnb    = await getBnbBalance(wallet.address).catch(() => 0);
      const msg =
        `💳 <b>Active Wallet</b>\n\n` +
        `Address: <code>${wallet.address}</code>\n` +
        `Balance: <b>${bnb.toFixed(4)} BNB</b>\n\n` +
        `To fund it, send BNB to the address above.`;
      return ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Token', callback_data: `bs_refresh_${ca}` }],
          ],
        },
      });
    }

    // Wallet cycle arrows (◀ ▶) on swap / limit panel
    if (data.startsWith('wallet_prev_') || data.startsWith('wallet_next_')) {
      const isNext  = data.startsWith('wallet_next_');
      const ca      = data.replace(isNext ? 'wallet_next_' : 'wallet_prev_', '');
      const wallets = await getUserWallets(tid);
      if (wallets.length <= 1) {
        return ctx.answerCbQuery('You only have one wallet.', { show_alert: false });
      }
      const activeIdx = wallets.findIndex(w => w.is_default === 1);
      const len       = wallets.length;
      const newIdx    = isNext ? (activeIdx + 1) % len : (activeIdx - 1 + len) % len;
      await setDefaultWallet(tid, wallets[newIdx].id);
      await ctx.answerCbQuery(`💳 ${wallets[newIdx].name}`);
      const { mode: pm } = getPanelMode(tid);
      return showTokenPanel(ctx, ca, ctx.callbackQuery.message?.message_id, pm);
    }

    // Refresh token panel
    if (data.startsWith('bs_refresh_')) {
      const ca = data.replace('bs_refresh_', '');
      const { mode: pm } = getPanelMode(tid);
      return showTokenPanel(ctx, ca, ctx.callbackQuery.message?.message_id, pm);
    }

    // Anti-MEV toggle
    if (data.startsWith('mev_toggle_')) {
      const ca = data.replace('mev_toggle_', '');
      const user = await getUser(tid);
      const newState = !(user?.anti_mev);
      await updateAntiMev(tid, newState);
      await ctx.answerCbQuery(
        newState ? '🛡️ Anti-MEV ON — tx routed via private mempool' : '🔴 Anti-MEV OFF',
        { show_alert: true }
      );
      const { mode: pm } = getPanelMode(tid);
      return showTokenPanel(ctx, ca, ctx.callbackQuery.message?.message_id, pm);
    }

    // Gas — preset selection (check gas_set_ before gas_open_)
    if (data.startsWith('gas_set_')) {
      const rest = data.replace('gas_set_', '');
      const gasPreset = rest.startsWith('medium_') ? 'medium' : rest.startsWith('fast_') ? 'fast' : rest.startsWith('turbo_') ? 'turbo' : null;
      if (gasPreset) {
        const ca = rest.replace(`${gasPreset}_`, '');
        userState.delete(tid);
        const { mode: pm } = getPanelMode(tid);
        const gasKey = pm === 'limit' ? 'limit_gas_mode' : 'swap_gas_mode';
        await updateUserSetting(tid, gasKey, gasPreset);
        const modeLabel = gasPreset === 'medium' ? '🐢 Medium' : gasPreset === 'fast' ? '🐴 Fast' : '🐋 Turbo';
        await ctx.answerCbQuery(`✅ Gas set to ${modeLabel}`, { show_alert: true });
        return showTokenPanel(ctx, ca, ctx.callbackQuery.message?.message_id, pm);
      }
    }

    // Gas — close/back: edit the same message back to token panel
    if (data.startsWith('gas_close_')) {
      const ca = data.replace('gas_close_', '');
      userState.delete(tid);
      const { mode: pm } = getPanelMode(tid);
      return showTokenPanel(ctx, ca, ctx.callbackQuery.message?.message_id, pm);
    }

    // Gas — open panel (edit in-place like slippage)
    if (data.startsWith('gas_open_')) {
      const ca = data.replace('gas_open_', '');
      const user = await getUser(tid);
      const { mode: pm } = getPanelMode(tid);
      const currentGas = pm === 'limit'
        ? (user?.limit_gas_mode ?? user?.gas_mode ?? 'medium')
        : (user?.swap_gas_mode  ?? user?.gas_mode ?? 'medium');
      const msgId = ctx.callbackQuery.message?.message_id;
      userState.set(tid, { mode: 'awaiting_gas_gwei', ca, msgId });
      const panel = gasPanel(ca, currentGas);
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, panel.text, {
        reply_markup: panel.keyboard,
      }).catch(() => ctx.reply(panel.text, { reply_markup: panel.keyboard }));
    }

    // Slippage — auto reset (check before generic slip_)
    if (data.startsWith('slip_auto_')) {
      const ca = data.replace('slip_auto_', '');
      userState.delete(tid);
      const { mode: pm } = getPanelMode(tid);
      const slipKey = pm === 'limit' ? 'limit_slippage' : 'swap_slippage';
      await updateUserSetting(tid, slipKey, 0);
      await ctx.answerCbQuery('✅ Auto slippage (10%) restored', { show_alert: true });
      return showTokenPanel(ctx, ca, ctx.callbackQuery.message?.message_id, pm);
    }

    // Slippage — close/back: edit the same message back to token panel
    if (data.startsWith('slip_close_')) {
      const ca = data.replace('slip_close_', '');
      userState.delete(tid);
      const { mode: pm } = getPanelMode(tid);
      const msgId = ctx.callbackQuery.message?.message_id;
      return showTokenPanel(ctx, ca, msgId, pm).catch(() => {});
    }

    // Slippage — open settings panel (edit in-place, show per-mode value)
    if (data.startsWith('slip_')) {
      const ca = data.replace('slip_', '');
      const user = await getUser(tid);
      const { mode: pm } = getPanelMode(tid);
      const currentSlip = pm === 'limit'
        ? (user?.limit_slippage ?? user?.slippage ?? 0)
        : (user?.swap_slippage  ?? user?.slippage ?? 0);
      const msgId = ctx.callbackQuery.message?.message_id;
      userState.set(tid, { mode: 'awaiting_slippage', ca, msgId });
      const panel = slippagePanel(ca, currentSlip);
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, panel.text, {
        reply_markup: panel.keyboard,
      }).catch(() => ctx.reply(panel.text, { reply_markup: panel.keyboard }));
    }

    // Preset buy: buy_<ca>_<amount>
    const buyMatch = data.match(/^buy_(0x[0-9a-fA-F]{40})_(\d+\.?\d*)$/);
    if (buyMatch) {
      return executeBuy(ctx, buyMatch[1], parseFloat(buyMatch[2]));
    }

    // Custom buy amount
    if (data.startsWith('buyx_')) {
      const ca = data.replace('buyx_', '');
      userState.set(tid, { mode: 'awaiting_buy_amount', ca });
      return ctx.reply('Enter the BNB amount to buy (e.g. 0.25):');
    }

    // Preset sell: sell_<ca>_<percent>
    const sellMatch = data.match(/^sell_(0x[0-9a-fA-F]{40})_(\d+)$/);
    if (sellMatch) {
      return executeSell(ctx, sellMatch[1], parseInt(sellMatch[2]));
    }

    // Custom sell percent
    if (data.startsWith('sellx_')) {
      const ca = data.replace('sellx_', '');
      userState.set(tid, { mode: 'awaiting_sell_percent', ca });
      return ctx.reply('Enter the percentage to sell (1–100):');
    }

    // ── Wallet management callbacks ───────────────────────────────────────────

    if (data === 'wl_list') {
      return showWalletList(ctx, tid, ctx.callbackQuery.message?.message_id);
    }

    if (data === 'wl_gen') {
      const count = await countUserWallets(tid);
      if (count >= 10) return ctx.answerCbQuery('⚠️ Maximum 10 wallets reached.', { show_alert: true });
      const available = 10 - count;
      userState.set(tid, { mode: 'awaiting_wallet_gen_count' });
      return ctx.reply(
        `🔑 <b>Generate Wallet</b>\n\nYou currently have <b>${count}</b> wallet${count !== 1 ? 's' : ''}. You can add up to <b>${available}</b> more (max 10 total).\n\nHow many wallets would you like to generate? (1–${available}):`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'wl_cancel_input' }]] },
        }
      );
    }

    if (data === 'wl_import') {
      const count = await countUserWallets(tid);
      if (count >= 10) return ctx.answerCbQuery('⚠️ Maximum 10 wallets reached.', { show_alert: true });
      userState.set(tid, { mode: 'awaiting_import_pk' });
      return ctx.reply(
        `📥 <b>Import Wallet</b>\n\nPlease enter the private key. Private key is encrypted, Only you know this !\n\n⚠️ Only import keys you trust on this bot.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'wl_cancel_input' }]] },
        }
      );
    }

    if (data === 'wl_cancel_input') {
      userState.delete(tid);
      await ctx.answerCbQuery('Cancelled.').catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data.startsWith('wl_view_')) {
      const wid = parseInt(data.replace('wl_view_', ''));
      return showWalletDetail(ctx, tid, wid, ctx.callbackQuery.message?.message_id);
    }

    if (data.startsWith('wl_default_')) {
      const wid = parseInt(data.replace('wl_default_', ''));
      await setDefaultWallet(tid, wid);
      await ctx.answerCbQuery('✅ Default wallet updated.', { show_alert: true });
      return showWalletDetail(ctx, tid, wid, ctx.callbackQuery.message?.message_id);
    }

    if (data.startsWith('wl_manual_')) {
      const wid = parseInt(data.replace('wl_manual_', ''));
      await toggleManualWallet(tid, wid);
      // Determine context: are we in wallet list or detail?
      const msgText = ctx.callbackQuery.message?.text || '';
      if (msgText.includes('My Wallets')) {
        return showWalletList(ctx, tid, ctx.callbackQuery.message?.message_id);
      }
      return showWalletDetail(ctx, tid, wid, ctx.callbackQuery.message?.message_id);
    }

    if (data.startsWith('wl_rename_')) {
      const wid = parseInt(data.replace('wl_rename_', ''));
      const w   = await getWallet(tid, wid);
      if (!w) return ctx.answerCbQuery('Wallet not found.', { show_alert: true });
      userState.set(tid, { mode: 'awaiting_wallet_rename', walletId: wid });
      return ctx.reply(`Enter a new name for wallet "${w.name}":`, {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'wl_cancel_input' }]] },
      });
    }

    if (data.startsWith('wl_export_')) {
      const wid = parseInt(data.replace('wl_export_', ''));
      const w   = await getWallet(tid, wid);
      if (!w) return ctx.answerCbQuery('Wallet not found.', { show_alert: true });
      const pk = decryptKey(w.encrypted_pk);
      const m = await ctx.reply(
        `🔑 <b>Private Key — ${w.name}</b>\n\n<tg-spoiler>${pk}</tg-spoiler>\n\n⚠️ <b>NEVER share this with anyone.</b>\nDelete this message after saving.\n\n<i>This message auto-deletes in 60 seconds.</i>`,
        { parse_mode: 'HTML' }
      );
      trackPkMsg(tid, ctx.chat.id, m.message_id, ctx.telegram);
      return;
    }

    if (data.startsWith('wl_sendb_')) {
      const wid = parseInt(data.replace('wl_sendb_', ''));
      userState.set(tid, { mode: 'awaiting_send_bnb_to', walletId: wid });
      return ctx.reply('💸 Enter recipient BSC address:', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'wl_cancel_input' }]] },
      });
    }

    if (data.startsWith('wl_delask_')) {
      const wid = parseInt(data.replace('wl_delask_', ''));
      const w   = await getWallet(tid, wid);
      if (!w) return ctx.answerCbQuery('Wallet not found.', { show_alert: true });
      if (w.is_default) return ctx.answerCbQuery('❌ Cannot delete the default wallet.', { show_alert: true });
      return ctx.reply(
        `⚠️ <b>Delete "${w.name}"?</b>\n\n<code>${w.address}</code>\n\nThis is permanent. Make sure you have saved the private key.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑️ Yes, Delete', callback_data: `wl_delconfirm_${wid}` }],
              [{ text: '❌ Cancel',       callback_data: 'wl_list' }],
            ],
          },
        }
      );
    }

    if (data.startsWith('wl_delconfirm_')) {
      const wid = parseInt(data.replace('wl_delconfirm_', ''));
      const affected = await deleteWallet(tid, wid);
      if (affected) {
        await ctx.answerCbQuery('✅ Wallet deleted.', { show_alert: true });
      } else {
        await ctx.answerCbQuery('❌ Cannot delete default wallet.', { show_alert: true });
      }
      return showWalletList(ctx, tid, ctx.callbackQuery.message?.message_id);
    }

    // ── Limit order tab: mode switch ──────────────────────────────────────────

    if (data.startsWith('mode_limit_')) {
      const ca  = data.replace('mode_limit_', '');
      const mid = ctx.callbackQuery.message?.message_id;
      setPanelMode(tid, ca, 'limit');
      return showTokenPanel(ctx, ca, mid, 'limit');
    }

    if (data.startsWith('mode_swap_')) {
      const ca  = data.replace('mode_swap_', '');
      const mid = ctx.callbackQuery.message?.message_id;
      setPanelMode(tid, ca, 'swap');
      return showTokenPanel(ctx, ca, mid, 'swap');
    }

    // ── Limit buy preset: lbuy_<ca>_<amount> ────────────────────────────────
    const lbuyMatch = data.match(/^lbuy_(0x[0-9a-fA-F]{40})_(\d+\.?\d*)$/);
    if (lbuyMatch) {
      const ca  = lbuyMatch[1];
      const amt = parseFloat(lbuyMatch[2]);
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`).catch(() => null);
      const dexData = res ? await res.json().catch(() => null) : null;
      const pair = (dexData?.pairs || []).find(p => p.chainId === 'bsc') || (dexData?.pairs || [])[0];
      const currentPrice = parseFloat(pair?.priceUsd || 0);
      userState.set(tid, { mode: 'awaiting_limit_trigger', ca, side: 'buy', amount: amt, currentPrice });
      return promptTriggerPrice(ctx, ca, 'buy', amt, currentPrice);
    }

    // ── Limit buy custom amount: lbuyx_<ca> ──────────────────────────────────
    if (data.startsWith('lbuyx_')) {
      const ca  = data.replace('lbuyx_', '');
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`).catch(() => null);
      const dexData = res ? await res.json().catch(() => null) : null;
      const pair = (dexData?.pairs || []).find(p => p.chainId === 'bsc') || (dexData?.pairs || [])[0];
      const currentPrice = parseFloat(pair?.priceUsd || 0);
      userState.set(tid, { mode: 'awaiting_limit_custom_buy', ca, currentPrice });
      return ctx.reply('Enter the BNB amount for the limit buy (e.g. 0.25):', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'limit_cancel_input' }]] },
      });
    }

    // ── Limit sell preset: lsell_<ca>_<percent> ─────────────────────────────
    const lsellMatch = data.match(/^lsell_(0x[0-9a-fA-F]{40})_(\d+)$/);
    if (lsellMatch) {
      const ca  = lsellMatch[1];
      const pct = parseInt(lsellMatch[2]);
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`).catch(() => null);
      const dexData = res ? await res.json().catch(() => null) : null;
      const pair = (dexData?.pairs || []).find(p => p.chainId === 'bsc') || (dexData?.pairs || [])[0];
      const currentPrice = parseFloat(pair?.priceUsd || 0);
      userState.set(tid, { mode: 'awaiting_limit_trigger', ca, side: 'sell', amount: pct, currentPrice });
      return promptTriggerPrice(ctx, ca, 'sell', pct, currentPrice);
    }

    // ── Limit sell custom percent: lsellx_<ca> ───────────────────────────────
    if (data.startsWith('lsellx_')) {
      const ca  = data.replace('lsellx_', '');
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`).catch(() => null);
      const dexData = res ? await res.json().catch(() => null) : null;
      const pair = (dexData?.pairs || []).find(p => p.chainId === 'bsc') || (dexData?.pairs || [])[0];
      const currentPrice = parseFloat(pair?.priceUsd || 0);
      userState.set(tid, { mode: 'awaiting_limit_custom_sell', ca, currentPrice });
      return ctx.reply('Enter the percent to limit sell (1–100):', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'limit_cancel_input' }]] },
      });
    }

    // ── Limit order list / management ────────────────────────────────────────
    if (data === 'limit_cancel_input') {
      userState.delete(tid);
      await ctx.answerCbQuery('Cancelled.').catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data === 'limit_list_refresh') {
      return showLimitOrdersList(ctx, tid);
    }

    if (data === 'limit_cancel_all') {
      return handleCancelAllLimitOrders(ctx);
    }

    const limitCancelMatch = data.match(/^limit_cancel_(\d+)$/);
    if (limitCancelMatch) {
      return handleCancelLimitOrder(ctx, parseInt(limitCancelMatch[1]));
    }

    // ── Custom Buy amount slots ───────────────────────────────────────────────
    if (data === 'cfg_custbuy_add') {
      const user = await getUser(tid);
      const buys = getCustomBuys(user);
      const nextSlot = buys.length < 5 ? buys.length + 1 : 5;
      userState.set(tid, { mode: 'awaiting_custom_buy', slot: nextSlot });
      const msgId = ctx.callbackQuery.message.message_id;
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null,
        `✏️ <b>Custom Buy Slot ${nextSlot}</b>\n\nEnter a BNB amount (e.g. <code>0.05</code>)\nEnter <code>0</code> to clear the slot:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cfg_global' }]] } }
      ).catch(() => ctx.reply(`✏️ Enter BNB amount for slot ${nextSlot}:`));
    }

    const custBuyMatch = data.match(/^cfg_custbuy_(\d+)$/);
    if (custBuyMatch) {
      const slot = parseInt(custBuyMatch[1]);
      userState.set(tid, { mode: 'awaiting_custom_buy', slot });
      const msgId = ctx.callbackQuery.message.message_id;
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null,
        `✏️ <b>Custom Buy Slot ${slot}</b>\n\nEnter a BNB amount (e.g. <code>0.05</code>)\nEnter <code>0</code> to clear this slot:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cfg_global' }]] } }
      ).catch(() => ctx.reply(`✏️ Enter BNB amount for slot ${slot}:`));
    }

    if (data === 'cfg_custsell_add') {
      const user = await getUser(tid);
      const sells = getCustomSells(user);
      const nextSlot = sells.length < 5 ? sells.length + 1 : 5;
      userState.set(tid, { mode: 'awaiting_custom_sell', slot: nextSlot });
      const msgId = ctx.callbackQuery.message.message_id;
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null,
        `✏️ <b>Custom Sell Slot ${nextSlot}</b>\n\nEnter a percentage (1–100)\nEnter <code>0</code> to clear the slot:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cfg_global' }]] } }
      ).catch(() => ctx.reply(`✏️ Enter sell percentage for slot ${nextSlot}:`));
    }

    const custSellMatch = data.match(/^cfg_custsell_(\d+)$/);
    if (custSellMatch) {
      const slot = parseInt(custSellMatch[1]);
      userState.set(tid, { mode: 'awaiting_custom_sell', slot });
      const msgId = ctx.callbackQuery.message.message_id;
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null,
        `✏️ <b>Custom Sell Slot ${slot}</b>\n\nEnter a percentage (1–100)\nEnter <code>0</code> to clear this slot:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cfg_global' }]] } }
      ).catch(() => ctx.reply(`✏️ Enter sell percentage for slot ${slot}:`));
    }

    // ── Auto Sell ─────────────────────────────────────────────────────────────
    if (data === 'cfg_autosell') {
      const msgId = ctx.callbackQuery.message.message_id;
      return showAutoSellPage(ctx, tid, msgId);
    }

    if (data === 'as_add') {
      const msgId = ctx.callbackQuery.message.message_id;
      return showAddRulePage(ctx, tid, msgId);
    }

    if (data === 'as_toggle_global') {
      const user = await getUser(tid);
      await setUserAutoSell(tid, !user?.autosell_enabled);
      const msgId = ctx.callbackQuery.message.message_id;
      return showAutoSellPage(ctx, tid, msgId);
    }

    const asToggleMatch = data.match(/^as_toggle_(\d+)$/);
    if (asToggleMatch) {
      await toggleAutoSellRule(parseInt(asToggleMatch[1]), tid);
      const msgId = ctx.callbackQuery.message.message_id;
      return showAutoSellPage(ctx, tid, msgId);
    }

    const asDelMatch = data.match(/^as_del_(\d+)$/);
    if (asDelMatch) {
      await deleteAutoSellRule(parseInt(asDelMatch[1]), tid);
      await ctx.answerCbQuery('Rule deleted.', { show_alert: true });
      const msgId = ctx.callbackQuery.message.message_id;
      return showAutoSellPage(ctx, tid, msgId);
    }

    if (data.startsWith('as_addtype_')) {
      const ruleType = data.replace('as_addtype_', '');
      const isTrailing = ruleType === 'trailing';
      const isSl = ruleType === 'sl' || isTrailing;
      userState.set(tid, { mode: 'awaiting_autosell_trigger', ruleType });
      const msgId = ctx.callbackQuery.message.message_id;
      const desc = isTrailing
        ? 'Enter the trailing stop % (e.g. <code>10</code> for 10% drop from peak):'
        : isSl
          ? 'Enter the stop-loss % (e.g. <code>50</code> for -50%):'
          : 'Enter the take-profit % (e.g. <code>50</code> for +50%):';
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null,
        `✏️ <b>Add ${ruleType.toUpperCase()} Rule</b>\n\n${desc}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cfg_autosell' }]] } }
      ).catch(() => ctx.reply(desc, { parse_mode: 'HTML' }));
    }
  });

  bot.catch((err, ctx) => {
    console.error(`[Bot Error] ${ctx.updateType}:`, err.message);
    ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
  });

  // Register commands (shows small "Menu" button at bottom-left of chat)
  bot.telegram.setMyCommands([
    { command: 'start',      description: '🏠 Home' },
    { command: 'wallet',     description: '💼 My Wallet' },
    { command: 'limit',      description: '📋 Limit Orders' },
    { command: 'history',    description: '📜 Trade history' },
    { command: 'trending',   description: '🔥 Trending on flap.sh' },
    { command: 'recentbond', description: '🎓 Recently bonded tokens' },
    { command: 'newcreated', description: '🆕 Newly created tokens (live)' },
    { command: 'snipe',      description: '🎯 Snipe a token' },
    { command: 'alert',      description: '🔔 Set price alert' },
    { command: 'scan',       description: '🔍 Scan token security' },
    { command: 'settings',   description: '⚙️ Trade settings' },
    { command: 'cancel',     description: '❌ Cancel all pending' },
    { command: 'tip',        description: '💸 Tip a token or BNB to a user' },
    { command: 'referral',   description: '🎁 Referral rewards' },
    { command: 'commands',   description: '📋 All commands' },
    { command: 'help',       description: '❓ Help' },
  ]).catch(() => {});

  // Set the small native "Menu" button (bottom-left, next to attachment icon)
  bot.telegram.callApi('setChatMenuButton', {
    menu_button: { type: 'commands' },
  }).catch(() => {});

  return bot;
}
