import { getManualWalletData, getTokenBalance } from '../lib/walletLib.js';
import { autoSwapSell } from '../lib/swap.js';
import { saveTrade, getUser } from '../lib/db.js';
import { sellSuccessMsg, sellFailMsg } from '../lib/notify.js';
import { walletLabel } from '../lib/walletLabel.js';

export async function handleSell(ctx) {
  const telegramId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const ca = args[0];
  const percentStr = args[1];

  if (!ca || !ca.startsWith('0x') || ca.length !== 42) {
    return ctx.reply('Usage: /sell <CA> <percent>\nExample: /sell 0x1234...abcd 50\n(Use 100 to sell all)');
  }

  const percent = parseInt(percentStr) || 100;
  if (percent < 1 || percent > 100) return ctx.reply('\u274c Percent must be 1-100.');

  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please use /start first.');

  let wallet;
  try { wallet = await getManualWalletData(telegramId); }
  catch (error) { return ctx.reply(error.message); }

  let tokenBal;
  try {
    tokenBal = await getTokenBalance(wallet.address, ca);
  } catch (e) {
    return ctx.reply(
      `<b>Buzzo — Could Not Read Balance</b>\n\nUnable to fetch token balance. Check your network or try again.`,
      { parse_mode: 'HTML' }
    );
  }

  if (tokenBal.formatted <= 0) {
    return ctx.reply(`\u274c No ${tokenBal.symbol || 'token'} balance in your wallet.`);
  }

  const msg = await ctx.reply(`\u23f3 Selling ${percent}% of ${tokenBal.formatted.toLocaleString()} ${tokenBal.symbol}...`);

  try {
    const slippage = user.swap_slippage ?? user.slippage ?? 10;
    const result   = await autoSwapSell(wallet.privateKey, ca, percent, slippage, false, 'medium', telegramId);
    await saveTrade(telegramId, ca, 'sell', result.receivedBnb, result.feeBnb || 0, result.txHash, 'success');

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      sellSuccessMsg(ca, tokenBal.symbol, percent, result.receivedBnb, result.txHash, result.router || 'PancakeSwap V2', 0, 0, walletLabel(wallet), result),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch (e) {
    await saveTrade(telegramId, ca, 'sell', 0, 0, null, 'failed');
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      sellFailMsg(ca, e),
      { parse_mode: 'HTML' }
    );
  }
}
