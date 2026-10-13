import { getActiveWalletData, getBnbBalance } from '../lib/walletLib.js';
import { buyToken, getQuote } from '../lib/swap.js';
import { saveTrade, getUser } from '../lib/db.js';
import { buySuccessMsg, buyFailMsg } from '../lib/notify.js';

export async function handleBuy(ctx) {
  const telegramId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const ca = args[0];
  const bnbStr = args[1];

  if (!ca || !ca.startsWith('0x') || ca.length !== 42 || !bnbStr) {
    return ctx.reply('Usage: /buy <CA> <BNB amount>\nExample: /buy 0x1234...abcd 0.05');
  }

  const bnbAmount = parseFloat(bnbStr);
  if (isNaN(bnbAmount) || bnbAmount <= 0) {
    return ctx.reply('❌ Invalid BNB amount.');
  }

  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please use /start first.');

  const wallet  = await getActiveWalletData(telegramId);
  const balance = await getBnbBalance(wallet.address).catch(() => 0);

  if (balance < bnbAmount + 0.002) {
    return ctx.reply(
      `❌ Insufficient BNB\nYou have: ${balance.toFixed(4)} BNB\nNeeded: ${(bnbAmount + 0.002).toFixed(4)} BNB (includes gas)\n\nDeposit to: <code>${wallet.address}</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const msg = await ctx.reply('⏳ Getting quote...');

  try {
    await getQuote(ca, bnbAmount - (bnbAmount * 0.003));
    const slippage = user.swap_slippage ?? user.slippage ?? 10;

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `📊 <b>Confirm Buy</b>\n\nSpend: ${bnbAmount} BNB\nSlippage: ${slippage}%\n\nReply /confirmbuy_${ca}_${bnbAmount} to confirm`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      buyFailMsg(ca, e),
      { parse_mode: 'HTML' }
    );
  }
}

export async function handleConfirmBuy(ctx) {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;
  const match = text.match(/^\/confirmbuy_(0x[a-fA-F0-9]{40})_(\d+\.?\d*)$/);
  if (!match) return;

  const ca        = match[1];
  const bnbAmount = parseFloat(match[2]);

  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please use /start first.');

  const wallet = await getActiveWalletData(telegramId);
  const msg    = await ctx.reply('🔄 Executing buy...');

  try {
    const result = await buyToken(wallet.privateKey, ca, bnbAmount, user.swap_slippage ?? user.slippage ?? 10);
    await saveTrade(telegramId, ca, 'buy', bnbAmount, result.feeBnb, result.txHash, 'success');

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      buySuccessMsg(ca, result.swapBnb, result.txHash, result.router || 'PancakeSwap', result.tokensReceived, result.tokenSymbol, 0, 0, null, result),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch (e) {
    await saveTrade(telegramId, ca, 'buy', bnbAmount, 0, null, 'failed');
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      buyFailMsg(ca, e),
      { parse_mode: 'HTML' }
    );
  }
}
