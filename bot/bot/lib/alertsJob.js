import { getPendingAlerts, triggerAlert } from './db.js';
import { getProvider } from './walletLib.js';
import { ethers } from 'ethers';
import { getAlertPrice,normalizeLegacyAlertPrice,alertTargetReached } from './alertPrice.js';

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const ROUTER_ABI = ['function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] memory)'];

async function getCurrentPrice(ca) {
  try {
    return await getAlertPrice(ca);
  } catch {
    return null;
  }
}

export function startAlertsJob(bot) {
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const alerts = await getPendingAlerts();
      if (alerts.length === 0) return;

      const caMap = new Map();
      for (const a of alerts) {
        if (!caMap.has(a.ca)) caMap.set(a.ca, []);
        caMap.get(a.ca).push(a);
      }

      for (const [ca, caAlerts] of caMap) {
        const price = await getCurrentPrice(ca);
        if (!price) continue;

        for (const alert of caAlerts) {
          let entryPrice = parseFloat(alert.entry_price);
          if (alert.price_unit !== 'bnb') {
            const token = new ethers.Contract(ca,['function decimals() view returns (uint8)'],getProvider());
            entryPrice = normalizeLegacyAlertPrice(entryPrice,await token.decimals());
          }
          if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
          const targetPrice = entryPrice * parseFloat(alert.target_multiplier);
          const multiplier = parseFloat(alert.target_multiplier);

          const hit = alertTargetReached(price,entryPrice,multiplier);
          if (!hit) continue;

          await triggerAlert(alert.id);

          const change = ((price - entryPrice) / entryPrice * 100).toFixed(1);
          const emoji = multiplier >= 1 ? '🚀' : '📉';

          await bot.telegram.sendMessage(alert.telegram_id,
            `${emoji} *Alert Triggered!*\n\nToken: \`${ca}\`\nEntry: ${entryPrice.toFixed(8)} BNB\nCurrent: ${price.toFixed(8)} BNB\nChange: ${change}%\n\nTarget ${alert.target_multiplier}x reached!`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[AlertsJob]', e.message);
    } finally { checking = false; }
  }, 15000);

  console.log('[AlertsJob] Started — checking every 15s');
}
