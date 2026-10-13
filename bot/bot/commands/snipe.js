import { getUser, createSnipeBatch, cancelUserSnipes, getUserWallets } from '../lib/db.js';
import { getBnbBalance } from '../lib/walletLib.js';
import { ethers } from 'ethers';

export async function doSnipe(ctx, telegramId, ca, bnbAmount) {
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please use /start first.');

  if (!Number.isFinite(bnbAmount) || bnbAmount <= 0 || !ethers.isAddress(ca)) return ctx.reply('Invalid BSC token address or amount.');
  const wallets = (await getUserWallets(telegramId)).filter(wallet => wallet.is_manual);
  if (!wallets.length) return ctx.reply('Select at least one wallet in Account → Manual before sniping.');
  const balances = await Promise.all(wallets.map(wallet => getBnbBalance(wallet.address)));
  const unfunded = wallets.filter((wallet, index) => balances[index] < bnbAmount + 0.003);
  if (unfunded.length) return ctx.reply(`Insufficient BNB in: ${unfunded.map(wallet => wallet.name).join(', ')}. Each selected wallet needs ${(bnbAmount + 0.003).toFixed(6)} BNB.`);
  const snipes = await createSnipeBatch(telegramId, ca, bnbAmount, wallets.map(wallet => wallet.id));

  await ctx.replyWithMarkdown(`🎯 *Snipe Set!*

Token: \`${ca}\`
Amount: ${bnbAmount} BNB per wallet
Wallets: ${wallets.length}

Watching for a supported liquid BSC route (follow-up sniping, not zero-block).
Use /cancel to stop.

IDs: ${snipes.map(snipe => '#' + snipe.id).join(', ')}`);
}

export async function handleSnipe(ctx) {
  const telegramId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const ca = args[0];
  const bnbStr = args[1] || '0.05';

  if (!ca || !ca.startsWith('0x') || ca.length !== 42) {
    return ctx.reply('Usage: /snipe <CA> [BNB amount]\nExample: /snipe 0x1234...abcd 0.1');
  }

  const bnbAmount = parseFloat(bnbStr);
  if (!Number.isFinite(bnbAmount) || bnbAmount <= 0) return ctx.reply('❌ Invalid BNB amount.');

  return doSnipe(ctx, telegramId, ca, bnbAmount);
}
