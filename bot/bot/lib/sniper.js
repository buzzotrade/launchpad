import { getPendingSnipes, updateSnipeStatus, getUser, getWallet, canNotifyUser, saveTrade } from './db.js';
import { decryptKey } from './walletLib.js';
import { autoSwapBuy, detectRouter } from './swap.js';
import { snipeSuccessMsg, snipeFailMsg } from './notify.js';
import { resolveSlippage } from './slippage.js';

let timer = null;
let polling = false;
const processing = new Set();
export async function executeSnipe(bot, snipe, swap = autoSwapBuy) {
  if (processing.has(snipe.id)) return;
  processing.add(snipe.id);
  try {
    if (!await canNotifyUser(snipe.telegram_id)) return;
    const wallet = await getWallet(snipe.telegram_id, snipe.wallet_id);
    if (!wallet) return;
    const user = await getUser(snipe.telegram_id);
    if (!user || !Number(user.notifications_enabled) || !await updateSnipeStatus(snipe.id, 'triggered')) return;
    const result = await swap(decryptKey(wallet.encrypted_pk), snipe.ca, Number(snipe.amount_bnb),
      resolveSlippage(user, 'sniper'), !!user?.anti_mev,
      user?.sniper_gas ? String(user.sniper_gas) : user?.gas_mode || 'medium', snipe.telegram_id);
    await saveTrade(snipe.telegram_id, snipe.ca, 'buy', snipe.amount_bnb, 0, result.txHash, 'success');
    await bot.telegram.sendMessage(snipe.telegram_id,
      snipeSuccessMsg(snipe.ca, result.swapBnb, result.txHash, result.router, result), { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  } catch (error) {
    await updateSnipeStatus(snipe.id, 'failed');
    await saveTrade(snipe.telegram_id, snipe.ca, 'buy', snipe.amount_bnb, 0, null, 'failed');
    await bot.telegram.sendMessage(snipe.telegram_id, snipeFailMsg(snipe.ca, error), { parse_mode: 'HTML' }).catch(() => {});
  } finally { processing.delete(snipe.id); }
}
export async function pollSnipes(bot, routeDetector = detectRouter, executor = executeSnipe) {
  if (polling) return;
  polling = true;
  try {
    const snipes = await getPendingSnipes();
    const routes = new Map();
    for (const snipe of snipes) {
      const key = snipe.ca.toLowerCase();
      if (!routes.has(key)) routes.set(key, await routeDetector(snipe.ca).catch(() => 'none'));
      if (routes.get(key) !== 'none') await executor(bot, snipe);
    }
  } finally { polling = false; }
}
export function startSniperJob(bot) {
  if (timer) return;
  timer = setInterval(() => pollSnipes(bot).catch(() => console.error('[SniperJob] Route check failed.')), 2000);
  console.log('[SniperJob] Follow-up liquidity sniping across supported BSC routes — checking every 2s; not zero-block sniping.');
}
