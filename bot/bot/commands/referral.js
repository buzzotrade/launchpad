import { getActiveWalletData } from '../lib/walletLib.js';
import {
  getReferralStats, getReferralInvitees, getReferralClaims,
  getUserReferredBy,
} from '../lib/db.js';
import { claimReferralSafely } from '../lib/referralPayouts.js';

const BOT_USERNAME = 'Buzzotrade_bot';
const MIN_CLAIM_BNB = 0;

function shortAddr(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10).replace(/-/g, '.');
}

function today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '.');
}

function referralKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Promo Details', callback_data: 'ref_promo' }],
      [
        { text: '💰 Claim Reward', callback_data: 'ref_claim' },
        { text: '📋 Claim Records', callback_data: 'ref_records' },
      ],
      [{ text: '🔙 Back', callback_data: 'menu_main' }],
    ],
  };
}

export async function showReferralPage(ctx, telegramId) {
  try {
    const wallet     = await getActiveWalletData(telegramId).catch(() => null);
    const stats      = await getReferralStats(telegramId);
    const referredBy = await getUserReferredBy(telegramId).catch(() => null);
    const link       = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;
    const addr       = wallet?.address || null;

    const periodStart = stats.user_created_at ? fmtDate(stats.user_created_at) : '—';

    const tierLine = stats.next_tier
      ? `🏅 Your Rate: <b>${stats.tier_rate_pct}%</b> — ${stats.next_tier}`
      : `🏅 Your Rate: <b>${stats.tier_rate_pct}%</b> — ⭐ VIP tier unlocked!`;

    const discountLine = referredBy
      ? `🎟️ Referral linked permanently. Rewards are included in the bot's quoted fee.\n`
      : '';

    const text =
      `🚀 <b>Invite friends and earn BNB rewards!</b>\n` +
      `Share your link — earn <b>${stats.tier_rate_pct}%</b> of every BNB trade your friends make.\n\n` +
      `🔗 <b>Referral Link:</b>\n<code>${link}</code>\n\n` +
      `💰 Total Reward: <b>${Number(stats.total_bnb || 0).toFixed(6)} BNB</b>\n` +
      `💰 Claimable Reward: <b>${Number(stats.claimable_bnb || 0).toFixed(6)} BNB</b>\n` +
      (Number(stats.pending_bnb) > 0 ? `Pending Payout: <b>${Number(stats.pending_bnb).toFixed(8)} BNB</b>\n` : '') +
      `👥 Users Referred: <b>${stats.count}</b>\n\n` +
      `${tierLine}\n` +
      `${discountLine}\n` +
      `💳 <b>Claimable Reward:</b>\n` +
      `BSC: <code>${addr ? shortAddr(addr) : '—'}</code> | ${Number(stats.claimable_bnb || 0).toFixed(6)} BNB\n\n` +
      `🎉 Grow the community — grow your rewards!\n\n` +
      `🔒 <i>Your referral ID and invitee attribution are permanent, tied to your Telegram ID. Referral rewards and earned balances do not expire.</i>`;

    const msgId = ctx.callbackQuery?.message?.message_id;
    if (msgId) {
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, {
        parse_mode: 'HTML',
        reply_markup: referralKeyboard(),
        disable_web_page_preview: true,
      }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: referralKeyboard(), disable_web_page_preview: true }));
    }
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: referralKeyboard(), disable_web_page_preview: true });
  } catch (e) {
    console.error('[referral]', e.message);
    return ctx.reply('❌ Error loading referral page.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_main' }]] },
    });
  }
}

export async function showPromoDetails(ctx) {
  const text =
    `📊 <b>Buzzo Referral Program</b>\n\n` +
    `<b>How it works:</b>\n` +
    `1. Share your personal referral link with friends\n` +
    `2. When they join via your link, they're permanently linked to you\n` +
    `3. Every time they trade, you automatically earn BNB\n` +
    `4. Rewards accumulate in real time — claim anytime\n\n` +
    `<b>Reward Tiers:</b>\n` +
    `• Base: <b>0.30%</b> nominal referral rate (0–19 invitees)\n` +
    `• ⭐ VIP: <b>0.35%</b> nominal rate (20+ invitees)\n` +
    `• Trades below 0.05 BNB: <b>0.30%</b> referral reward, including VIP\n` +
    `• Larger trades use the tier rate with a USD $1 minimum referral reward\n` +
    `• Works on both buys and sells — no cap\n\n` +
    `<b>Trading Fees:</b>\n` +
    `• Bot fees are separate from DEX pool fees and network gas\n` +
    `• Referral rewards are part of the bot fee, not taken from the pool's LP fees\n` +
    `• Larger trades include USD minimums; there is no guaranteed flat discount\n\n` +
    `<b>Permanent Referrals:</b>\n` +
    `• Referral attribution and earned rewards <b>never expire</b>\n` +
    `• Each invitee stays linked to their original referrer permanently\n` +
    `• Changing username, restarting or using a new link does not replace that referrer\n\n` +
    `<b>Claim Rules:</b>\n` +
    `• Network gas deducted on claim\n` +
    `• Paid directly to your active BSC wallet\n\n` +
    `<b>BSC Network only</b> — all rewards in BNB.`;

  const msgId = ctx.callbackQuery?.message?.message_id;
  const kb = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ref_main' }]] };
  if (msgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, {
      parse_mode: 'HTML', reply_markup: kb,
    }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  }
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleClaimReward(ctx, telegramId) {
  try {
    const wallet = await getActiveWalletData(telegramId);
    if (!wallet?.address) {
      return ctx.answerCbQuery("No active wallet found.", { show_alert: true });
    }
    await ctx.answerCbQuery("Processing claim...", { show_alert: false });
    const result = await claimReferralSafely(telegramId,wallet.address);
    const messages = {
      empty: 'No claimable reward yet.',
      unfunded: 'The reward pool is awaiting funding. Your reward balance is unchanged.',
      busy: 'A reward payout is being processed. Please check again shortly.',
      blocked: 'The payout could not be prepared. Your reward balance has been restored.',
      failed: 'The payout reverted. Your reward balance has been restored.',
      pending: 'Your payout is awaiting confirmation. Do not submit it again.',
    };
    const text = result.kind === 'completed'
      ? `<b>Reward received: ${result.receivedBnb} BNB</b>` : messages[result.kind];
    const link = result.hash ? `\n\n<a href="https://bscscan.com/tx/${result.hash}">View Transaction</a>` : '';
    return ctx.reply(text + link, { parse_mode:'HTML',reply_markup:{inline_keyboard:[
      [{text:'Claim Records',callback_data:'ref_records'}],[{text:'Back to Referral',callback_data:'ref_main'}],
    ]} });
  } catch {
    console.error('[Referral] Claim status could not be checked; journal retained.');
    return ctx.reply('Could not check this claim. Check Claim Records before trying again.', {
      reply_markup:{inline_keyboard:[[{text:'Claim Records',callback_data:'ref_records'}]]},
    });
  }
}
export async function showClaimRecords(ctx, telegramId) {
  try {
    const records = await getReferralClaims(telegramId);
    const msgId   = ctx.callbackQuery?.message?.message_id;
    const kb = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ref_main' }]] };

    if (!records.length) {
      const text = `📋 <b>Claim Records</b>\n\nNo claims yet. Refer friends to start earning!`;
      if (msgId) {
        return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, { parse_mode: 'HTML', reply_markup: kb })
          .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
      }
      return ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }

    const lines = records.slice(0, 10).map((r, i) =>
      `${i + 1}. <b>${Number(r.amount_bnb).toFixed(6)} BNB</b> — ${new Date(r.created_at).toISOString().slice(0, 10)} — ${r.status}`
    ).join('\n');

    const text = `📋 <b>Claim Records</b> (last ${records.slice(0, 10).length})\n\n${lines}`;
    if (msgId) {
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, { parse_mode: 'HTML', reply_markup: kb })
        .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
    }
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    console.error('[referral records]', e.message);
    return ctx.reply('❌ Error loading claim records.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ref_main' }]] },
    });
  }
}
