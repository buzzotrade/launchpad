import { getUser, createAlert } from '../lib/db.js';
import { getProvider } from '../lib/walletLib.js';
import { ethers } from 'ethers';
import { getAlertPrice } from '../lib/alertPrice.js';

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const ROUTER_ABI = ['function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] memory)'];

async function getCurrentPrice(ca) {
  return getAlertPrice(ca);
}

export async function setAlertForCA(ctx, telegramId, ca, targetStr) {
  const multiplierStr = targetStr.replace(/x$/i, '');
  const multiplier = /^\d+(?:\.\d+)?$/.test(multiplierStr) ? Number(multiplierStr) : NaN;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return ctx.reply('❌ Invalid target. Use like: 2x or 0.5x');

  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please use /start first.');

  const msg = await ctx.reply('📊 Getting current price...');

  try {
    const entryPrice = await getCurrentPrice(ca);
    const alert = await createAlert(telegramId, ca, multiplier, entryPrice);
    const targetPrice = entryPrice * multiplier;

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `🔔 *Alert Set!*\n\nToken: \`${ca}\`\nEntry: ${entryPrice.toFixed(8)} BNB/token\nTarget: ${targetPrice.toFixed(8)} BNB (${multiplier}x)\n\nYou'll be notified when the price hits the target.\nUse /cancel to remove.\n\nID: #${alert.id}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Failed to set alert: ${e.message}`);
  }
}

export async function handleAlert(ctx) {
  const telegramId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const ca = args[0];
  const targetStr = args[1];

  if (!ca || !ca.startsWith('0x') || ca.length !== 42 || !targetStr) {
    return ctx.reply('Usage: /alert <CA> <target>\nExamples:\n/alert 0x... 2x  (notify at 2x)\n/alert 0x... 0.5x  (notify at 50% drop)');
  }

  return setAlertForCA(ctx, telegramId, ca, targetStr);
}
