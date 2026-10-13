import { ethers } from 'ethers';
import { getActiveWalletData, getBnbBalance, getTokenBalance, getProvider, decryptKey, sendBnb, sendToken } from '../lib/walletLib.js';
import { getUser, getPendingTipsForUser, markTipCompleted, markTipFailed, getDefaultWallet } from '../lib/db.js';
import { tipRecipientWallet } from '../lib/tipRecipients.js';

const BUZZO_CA = process.env.BUZZO_NATIVE_TOKEN_CA || null;
const MIN_BNB_GAS = 0.001;
const RATE_LIMIT_MS = 30_000;
const MAX_PARTY = 20;

// ─── Known BSC tokens (symbol → CA) ──────────────────────────────────────────
const KNOWN_TOKENS = {
  ...(BUZZO_CA ? { BUZZO: BUZZO_CA } : {}),
  USDT:  '0x55d398326f99059fF775485246999027B3197955',
  USDC:  '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  BUSD:  '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  WBNB:  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  CAKE:  '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  ETH:   '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
};

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
];

const tipCooldown = new Map();
const esc = value => String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function isRateLimited(userId) {
  const last = tipCooldown.get(userId);
  if (!last) return false;
  return Date.now() - last < RATE_LIMIT_MS;
}
function setRateLimit(userId) { tipCooldown.set(userId, Date.now()); }

// ─── Token resolver ───────────────────────────────────────────────────────────
// Returns { symbol, ca, isNative } or null if arg is not a token
function resolveTokenArg(arg) {
  if (!arg) return null;
  const up = arg.toUpperCase();
  if (up === 'BNB') return { symbol: 'BNB', ca: null, isNative: true };
  if (KNOWN_TOKENS[up]) return { symbol: up, ca: KNOWN_TOKENS[up], isNative: false };
  if (/^0x[0-9a-fA-F]{40}$/.test(arg)) return { symbol: null, ca: arg, isNative: false };
  return null;
}

// ─── Transfer helpers ─────────────────────────────────────────────────────────
async function transferERC20(privateKey, ca, toAddress, amountDisplay, telegramId) {
  const provider = getProvider();
  const signer   = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(ca, ERC20_ABI, signer);
  const decimals = await contract.decimals();
  const amountWei = ethers.parseUnits(String(amountDisplay), decimals);
  return sendToken(privateKey, ca, toAddress, amountWei, telegramId);
}

async function getTokenSymbol(ca) {
  try {
    const provider = getProvider();
    const contract = new ethers.Contract(ca, ERC20_ABI, provider);
    return await contract.symbol();
  } catch { return '???'; }
}

async function getBuzzoPriceUsd() {
  if (!BUZZO_CA) return 0;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${BUZZO_CA}`);
    const json = await res.json();
    const pair = json?.pairs?.[0];
    return pair?.priceUsd ? parseFloat(pair.priceUsd) : 0;
  } catch { return 0; }
}

function partyEmojis(amount, priceUsd) {
  if (!priceUsd || priceUsd <= 0) return '💸';
  const usdValue = amount * priceUsd;
  const count = Math.max(1, Math.min(MAX_PARTY, Math.floor(usdValue / 10)));
  return '💸'.repeat(count);
}

function isGroup(ctx) {
  const type = ctx.chat?.type;
  return type === 'group' || type === 'supergroup' || type === 'channel';
}

async function autoDelete(ctx, msgId, ms = 60_000) {
  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(() => {});
  }, ms);
}

async function replyAndAutoDel(ctx, text, opts = {}) {
  const msg = await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
  if (isGroup(ctx)) autoDelete(ctx, msg.message_id, 60_000);
  return msg;
}

async function editAndAutoDel(ctx, msgId, text, autodel = true, ms = 90_000) {
  await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, {
    parse_mode: 'HTML', disable_web_page_preview: true,
  }).catch(async () => {
    const m = await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => null);
    if (m && isGroup(ctx) && autodel) autoDelete(ctx, m.message_id, ms);
  });
  if (isGroup(ctx) && autodel) autoDelete(ctx, msgId, ms);
}

// ─── /tip handler ─────────────────────────────────────────────────────────────
export async function handleTip(ctx) {
  const senderId       = ctx.from?.id;
  const senderHandle   = ctx.from?.username ? `@${esc(ctx.from.username)}` : esc(ctx.from?.first_name || 'Someone');
  const senderUsername = (ctx.from?.username || '').toLowerCase();

  // Strip @botname suffix (e.g. /tip@Buzzotrade_bot → /tip)
  const rawText = (ctx.message?.text || '').trim().replace(/^\/\w+@\S+/, (m) => m.split('@')[0]);
  const args    = rawText.split(/\s+/);

  // Reply detection
  const replyMsg  = ctx.message?.reply_to_message;
  const replyUser = replyMsg?.from;
  const isReply   = !!replyUser && !replyUser.is_bot && !replyUser.is_anonymous && !!replyUser.id;

  const usageHint =
    '💸 <b>Tip tokens to another user</b>\n\n' +
    '<b>Syntax:</b>\n' +
    '<code>/tip &lt;amount&gt; [token] [Telegram ID or @username]</code>\n\n' +
    '<b>Examples:</b>\n' +
    '• <code>/tip 0.001 BNB</code> — tip 0.001 BNB (reply to target)\n' +
    '• <code>/tip 0.001 BNB @username</code> — tip 0.001 BNB\n' +
    '• <code>/tip 1 BNB @aamon</code> — tip 1 BNB\n' +
    '• <code>/tip 10 USDT @aamon</code> — tip 10 USDT\n' +
    '• <code>/tip 100 0x1234...abcd @aamon</code> — tip any token by CA\n\n' +
    '<b>Supported tokens:</b> BNB (default until BUZZO is configured), BUZZO, USDT, USDC, BUSD, WBNB, CAKE\n' +
    '• In groups: reply to a message instead of typing @username\n' +
    '• Use a reply or Telegram ID for new recipients\n' +
    '• Tips reach their Buzzo wallet; /start opens it';

  if (args.length < 2) {
    return replyAndAutoDel(ctx, usageHint);
  }

  const rawAmount = args[1].replace(/,/g, '');
  const amount    = parseFloat(rawAmount);
  if (!/^\d+(?:\.\d+)?$/.test(rawAmount) || !Number.isFinite(amount) || amount <= 0) {
    return replyAndAutoDel(ctx, '❌ Invalid amount. Example: <code>/tip 5000</code> or <code>/tip 1 BNB @aamon</code>');
  }

  // ─── Parse optional token and recipient from remaining args ─────────────────
  // Syntax: /tip <amount> [<token>] [<@username>]
  // token can be: BNB, USDT, USDC, BUSD, WBNB, CAKE, configured BUZZO, or 0x... CA
  // @username can be with or without the @ prefix (but must come after token)
  let token = BUZZO_CA ? { symbol: 'BUZZO', ca: BUZZO_CA, isNative: false } : { symbol: 'BNB', ca: null, isNative: true };
  let usernameFromArgs = null;
  let recipientIdFromArgs = null;

  const rest = args.slice(2);
  for (const arg of rest) {
    const resolved = resolveTokenArg(arg);
    if (resolved) {
      token = resolved;
    } else if (arg.startsWith('@')) {
      if (usernameFromArgs || recipientIdFromArgs) return replyAndAutoDel(ctx,'Specify only one recipient.');
      // Only treat @-prefixed words as usernames; ignore plain text / message content
      usernameFromArgs = arg.replace(/^@/, '').toLowerCase();
    } else if (/^\d+$/.test(arg)) {
      if (usernameFromArgs || recipientIdFromArgs) return replyAndAutoDel(ctx,'Specify only one recipient.');
      recipientIdFromArgs = Number(arg);
      if (!Number.isSafeInteger(recipientIdFromArgs) || recipientIdFromArgs <= 0)
        return replyAndAutoDel(ctx,'Invalid Telegram ID.');
    }
    // anything else (message text, commas, plain words) is silently ignored
  }

  // ─── Determine recipient ────────────────────────────────────────────────────
  let recipientUsername;
  let recipientTelegramId = null;
  let recipientDisplayName;

  if (recipientIdFromArgs) {
    recipientTelegramId = recipientIdFromArgs;
    recipientUsername = '';
    recipientDisplayName = `<a href="tg://user?id=${recipientTelegramId}">Telegram ID ${recipientTelegramId}</a>`;
  } else if (usernameFromArgs) {
    recipientUsername    = usernameFromArgs;
    recipientDisplayName = `@${recipientUsername}`;
  } else if (isReply) {
    recipientUsername    = (replyUser.username || '').toLowerCase();
    recipientTelegramId  = replyUser.id;
    recipientDisplayName = replyUser.username ? `@${esc(replyUser.username)}` : esc(replyUser.first_name);
  } else {
    if (isGroup(ctx)) {
      return replyAndAutoDel(ctx,
        '💸 <b>How to tip in a group:</b>\n\n' +
        '1. Press &amp; hold (or swipe) on the message you want to tip\n' +
        '2. Tap <b>Reply</b>\n' +
        '3. Send: <code>/tip &lt;amount&gt;</code>\n\n' +
        'Or tip by username: <code>/tip &lt;amount&gt; @username</code>'
      );
    }
    return replyAndAutoDel(ctx, usageHint);
  }

  if (!recipientUsername && !recipientTelegramId) {
    return replyAndAutoDel(ctx, '❌ Please specify a recipient. Example: <code>/tip 5000 @aamon</code>');
  }
  if (recipientTelegramId === senderId || (recipientUsername && recipientUsername === senderUsername)) {
    return replyAndAutoDel(ctx, '❌ You cannot tip yourself.');
  }

  if (isRateLimited(senderId)) {
    const remaining = Math.ceil((RATE_LIMIT_MS - (Date.now() - tipCooldown.get(senderId))) / 1000);
    return replyAndAutoDel(ctx, `⏱ Please wait <b>${remaining}s</b> before tipping again.`);
  }

  // If CA-only token (no known symbol), fetch symbol from chain
  if (!token.symbol && token.ca) {
    token.symbol = await getTokenSymbol(token.ca);
  }

  const displaySymbol = token.symbol || token.ca?.slice(0, 8) + '...';
  const processing = await ctx.reply(`💸 Processing tip...`, { parse_mode: 'HTML' });

  try {
    const wallet = await getActiveWalletData(senderId);
    if (!wallet) {
      return editAndAutoDel(ctx, processing.message_id, '❌ No wallet found. Use /start to set up your wallet.');
    }

    const bnbBal = await getBnbBalance(wallet.address);

    // BNB tip — no gas check needed (amount includes BNB; check total)
    if (token.isNative) {
      const totalNeeded = amount + MIN_BNB_GAS;
      if (bnbBal < totalNeeded) {
        return editAndAutoDel(ctx, processing.message_id,
          `❌ <b>Tip failed</b> — Not enough BNB\n` +
          `You have <code>${bnbBal.toFixed(5)} BNB</code>, need <code>${totalNeeded.toFixed(5)} BNB</code> (amount + gas)`
        );
      }
      const target = await tipRecipientWallet({id:recipientTelegramId,username:recipientUsername,telegram:ctx.telegram});
      if (!target) {
        return editAndAutoDel(ctx, processing.message_id,
          'Recipient could not be verified. Reply to their message or use their Telegram ID. No funds were sent.'
        );
      }
      const {user:recipient,wallet:recipientWallet} = target;
      if (Number(recipient.telegram_id) === senderId) return editAndAutoDel(ctx,processing.message_id,'You cannot tip yourself.');

      setRateLimit(senderId);
      const txHash = await sendBnb(wallet.privateKey, recipientWallet.address, rawAmount, telegramId);
      const successMsg = `${senderHandle} tipped <b>${rawAmount} BNB</b> to ${recipientDisplayName} 💸\n` +
        '<a href="https://t.me/Buzzotrade_bot?start=tip">Open Buzzo to access your tip</a>\n' +
        `<a href="https://bscscan.com/tx/${txHash}">View Transaction</a>`;
      await editAndAutoDel(ctx, processing.message_id, successMsg);
      ctx.telegram.sendMessage(recipient.telegram_id,
        `💸 <b>You received a BNB tip!</b>\n\n<b>${amount} BNB</b> from ${senderHandle}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    // ERC20 tip
    if (bnbBal < MIN_BNB_GAS) {
      return editAndAutoDel(ctx, processing.message_id,
        `❌ <b>Tip failed</b> — Not enough BNB for gas\n` +
        `You have <code>${bnbBal.toFixed(5)} BNB</code>, need at least <code>${MIN_BNB_GAS} BNB</code>`
      );
    }

    const tokenInfo = await getTokenBalance(wallet.address, token.ca).catch(() => null);
    if (!tokenInfo) {
      return editAndAutoDel(ctx, processing.message_id,
        `❌ <b>Tip failed</b> — Could not fetch ${displaySymbol} balance. Check the token address.`
      );
    }

    const resolvedSymbol = token.symbol || tokenInfo.symbol;

    if (tokenInfo.formatted < amount) {
      return editAndAutoDel(ctx, processing.message_id,
        `❌ <b>Tip failed</b> — Insufficient ${resolvedSymbol} balance\n` +
        `You have <code>${tokenInfo.formatted.toLocaleString()} ${resolvedSymbol}</code>, tried to send <code>${amount.toLocaleString()} ${resolvedSymbol}</code>`
      );
    }

    const target = await tipRecipientWallet({id:recipientTelegramId,username:recipientUsername,telegram:ctx.telegram});
    if (!target) return editAndAutoDel(ctx,processing.message_id,
      'Recipient could not be verified. Reply to their message or use their Telegram ID. No funds were sent.');
    const {user:recipient,wallet:recipientWallet} = target;
    if (Number(recipient.telegram_id) === senderId) return editAndAutoDel(ctx,processing.message_id,'You cannot tip yourself.');

    const priceUsd = BUZZO_CA && token.ca === BUZZO_CA ? await getBuzzoPriceUsd() : 0;
    const party    = partyEmojis(amount, priceUsd);

    {
      setRateLimit(senderId);
      const txHash = await transferERC20(wallet.privateKey, token.ca, recipientWallet.address, rawAmount, telegramId);

      const successMsg =
        `${senderHandle} tipped <b>${rawAmount} ${resolvedSymbol}</b> to ${recipientDisplayName} ${party}\n` +
        '<a href="https://t.me/Buzzotrade_bot?start=tip">Open Buzzo to access your tip</a>\n' +
        `<a href="https://bscscan.com/tx/${txHash}">View Transaction</a>`;
      await editAndAutoDel(ctx, processing.message_id, successMsg, false);

      ctx.telegram.sendMessage(recipient.telegram_id,
        `${party} <b>You received a tip!</b>\n\n` +
        `💸 <b>${amount.toLocaleString()} ${resolvedSymbol}</b> from ${senderHandle}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});

    }

  } catch (err) {
    console.error('[Tip] Transfer status needs checking.');
    if ((err.transferPending || err.tradePending) && ethers.isHexString(err.txHash,32))
      return editAndAutoDel(ctx,processing.message_id,
        `Tip awaiting confirmation. Do not repeat it.\n<a href="https://bscscan.com/tx/${err.txHash}">View Transaction</a>`);
    await editAndAutoDel(ctx, processing.message_id,
      'Tip could not be completed. Check the amount, balance and recipient.'
    );
  }
}

// ─── Credit all pending tips on user join (any token) ────────────────────────
export async function creditPendingTips(telegramId, username, telegram = null) {
  const pending = await getPendingTipsForUser(telegramId, username || '').catch(() => []);
  if (!pending.length) return;

  const recipientWallet = await getDefaultWallet(telegramId).catch(() => null);
  if (!recipientWallet) return;

  for (const tip of pending) {
    try {
      const senderWallet = await getDefaultWallet(tip.sender_id).catch(() => null);
      if (!senderWallet) { await markTipFailed(tip.id); continue; }

      const privateKey   = decryptKey(senderWallet.encrypted_pk);
      const tipTokenCa   = tip.token_ca || BUZZO_CA;
      const tipSymbol    = tip.token_symbol || 'BUZZO';
      if (!tipTokenCa) continue;
      const tokenInfo    = await getTokenBalance(senderWallet.address, tipTokenCa).catch(() => null);

      if (!tokenInfo || tokenInfo.formatted < tip.amount) {
        await markTipFailed(tip.id);
        continue;
      }

      const priceUsd = BUZZO_CA && tipTokenCa === BUZZO_CA ? await getBuzzoPriceUsd() : 0;
      const txHash   = await transferERC20(privateKey, tipTokenCa, recipientWallet.address, tip.amount, Number(tip.sender_id));
      await markTipCompleted(tip.id, txHash);

      const party      = partyEmojis(tip.amount, priceUsd);
      const senderUser = await getUser(tip.sender_id).catch(() => null);
      const senderName = senderUser?.username ? `@${senderUser.username}` : 'Someone';

      if (telegram) {
        telegram.sendMessage(telegramId,
          `${party} <b>Pending tip received!</b>\n\n` +
          `💸 <b>${Number(tip.amount).toLocaleString()} ${tipSymbol}</b> from ${senderName}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});

        if (tip.sender_id) {
          telegram.sendMessage(tip.sender_id,
            `✅ Your queued tip of <b>${Number(tip.amount).toLocaleString()} ${tipSymbol}</b> to @${username} was delivered! ${party}`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }

    } catch (err) {
      console.error('[creditPendingTips]', err.message);
      await markTipFailed(tip.id).catch(() => {});
    }
  }
}
