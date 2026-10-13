import {
  getPendingAutoSellOrders, updateAutoSellOrderPeak, updateAutoSellOrderStatus,
} from './db.js';
import { autoSwapSell } from './swap.js';
import { sellSuccessMsg } from './notify.js';
import { decryptKey } from './walletLib.js';
import { getWallet, canNotifyUser, getUser } from './db.js';
import { resolveSlippage } from './slippage.js';

const INTERVAL_MS = 30_000;

async function getTokenPriceUsd(ca) {
  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    const data = await res.json();
    const pair = data?.pairs?.find(p => p.chainId === 'bsc') || data?.pairs?.[0];
    return pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
  } catch {
    return null;
  }
}

async function tick(bot) {
  const orders = await getPendingAutoSellOrders().catch(() => []);
  if (!orders.length) return;

  for (const order of orders) {
    try {
      if (!await canNotifyUser(order.telegram_id)) continue;
      const currentPrice = await getTokenPriceUsd(order.ca);
      if (!currentPrice || !order.buy_price_usd) continue;

      const buyPrice = parseFloat(order.buy_price_usd);
      if (buyPrice <= 0) continue;

      let shouldSell = false;
      let peakPrice  = order.peak_price_usd ? parseFloat(order.peak_price_usd) : buyPrice;
      const triggerPct = parseFloat(order.trigger_pct);
      const sellPct    = parseFloat(order.sell_pct);

      if (order.trailing) {
        if (currentPrice > peakPrice) {
          peakPrice = currentPrice;
          await updateAutoSellOrderPeak(order.id, peakPrice);
        }
        const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
        const threshold    = Math.abs(triggerPct);
        if (dropFromPeak >= threshold) shouldSell = true;
      } else {
        const changePct = ((currentPrice - buyPrice) / buyPrice) * 100;
        if (triggerPct < 0 && changePct <= triggerPct) shouldSell = true;
        if (triggerPct > 0 && changePct >= triggerPct) shouldSell = true;
      }

      if (!shouldSell) continue;

      await updateAutoSellOrderStatus(order.id, 'triggered');

      try {
        const wallets = await import('./db.js').then(m => m.getUserWallets(order.telegram_id));
        const w = wallets.find(x => x.address.toLowerCase() === order.wallet_address.toLowerCase());
        if (!w) continue;

        const encKey = w.encrypted_pk;
        const pk     = decryptKey(encKey);
        const user = await getUser(order.telegram_id);
        const result = await autoSwapSell(pk, order.ca, sellPct, resolveSlippage(user), false, 'medium', order.telegram_id);

        await bot.telegram.sendMessage(
          order.telegram_id,
          sellSuccessMsg(order.ca, result.tokenSymbol, sellPct, result.receivedBnb, result.txHash, result.router, 0, 0, null, result),
          { parse_mode: 'HTML', disable_web_page_preview: true }
        ).catch(() => {});
      } catch (e) {
        await updateAutoSellOrderStatus(order.id, 'failed');
        console.error('[AutoSell] Sell failed:', e.message);
      }
    } catch (e) {
      console.error('[AutoSell] Order error:', e.message);
    }
  }
}

export function startAutoSellWatcher(bot) {
  const run = () => tick(bot).catch(e => console.error('[AutoSell] tick error:', e.message));
  run();
  setInterval(run, INTERVAL_MS);
  console.log('[AutoSellWatcher] Started — checking every 30s');
}
