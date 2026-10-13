import { getPendingLimitOrders, updateLimitOrderStatus, getUser } from './db.js';
import { saveTrade } from './db.js';
import { decryptKey } from './walletLib.js';
import { getWallet, canNotifyUser } from './db.js';
import { autoSwapBuy, autoSwapSell } from './swap.js';
import { limitSuccessMsg, limitFailMsg } from './notify.js';

const PRICE_CACHE = new Map();
const EXECUTING   = new Set();

async function fetchPrice(ca) {
  const now    = Date.now();
  const cached = PRICE_CACHE.get(ca.toLowerCase());
  if (cached && now - cached.ts < 20000) return cached.price;
  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    const data = await res.json();
    const pair = (data?.pairs || []).find(p => p.chainId === 'bsc') || (data?.pairs || [])[0];
    const price = parseFloat(pair?.priceUsd || 0);
    if (price > 0) PRICE_CACHE.set(ca.toLowerCase(), { price, ts: now });
    return price;
  } catch {
    return 0;
  }
}

export function startLimitWatcher(bot) {
  setInterval(async () => {
    try {
      const orders = await getPendingLimitOrders();
      if (!orders.length) return;

      const cas    = [...new Set(orders.map(o => o.ca.toLowerCase()))];
      const prices = {};
      await Promise.all(cas.map(async ca => { prices[ca] = await fetchPrice(ca); }));

      for (const order of orders) {
        if (EXECUTING.has(order.id)) continue;
        const price = prices[order.ca.toLowerCase()];
        if (!price) continue;

        const hit =
          (order.side === 'buy'  && price <= parseFloat(order.trigger_price)) ||
          (order.side === 'sell' && price >= parseFloat(order.trigger_price));

        if (!hit) continue;

        EXECUTING.add(order.id);
        await updateLimitOrderStatus(order.id, 'triggered');

        setImmediate(async () => {
          try {
            const user    = await getUser(order.telegram_id).catch(() => null);
            if (!await canNotifyUser(order.telegram_id)) return;
            const record = await getWallet(order.telegram_id, order.wallet_id);
            if (!record) return;
            const wallet = { privateKey: decryptKey(record.encrypted_pk) };
            const slip    = parseFloat(user?.limit_slippage ?? user?.slippage ?? 0) || 10;
            const gasMode = user?.limit_gas_mode ?? user?.gas_mode ?? 'medium';
            const antiMev = !!(user?.anti_mev);
            const amt     = parseFloat(order.amount);

            let result;
            if (order.side === 'buy') {
              result = await autoSwapBuy(wallet.privateKey, order.ca, amt, slip, antiMev, gasMode, order.telegram_id);
              await saveTrade(order.telegram_id, order.ca, 'buy', amt, 0, result.txHash, 'success');
            } else {
              result = await autoSwapSell(wallet.privateKey, order.ca, amt, slip, antiMev, gasMode, order.telegram_id);
              await saveTrade(order.telegram_id, order.ca, 'sell', result.receivedBnb || 0, 0, result.txHash, 'success');
            }

            await bot.telegram.sendMessage(
              order.telegram_id,
              limitSuccessMsg(order.id, order.side, order.ca, price, amt, result.txHash, result.router, result),
              { parse_mode: 'HTML', disable_web_page_preview: true }
            ).catch(() => {});
          } catch (e) {
            await updateLimitOrderStatus(order.id, 'failed').catch(() => {});
            await bot.telegram.sendMessage(
              order.telegram_id,
              limitFailMsg(order.id, order.ca, e),
              { parse_mode: 'HTML' }
            ).catch(() => {});
          } finally {
            EXECUTING.delete(order.id);
          }
        });
      }
    } catch (e) {
      console.error('[LimitWatcher]', e.message);
    }
  }, 30000);

  console.log('[LimitWatcher] Started — checking every 30s');
}
