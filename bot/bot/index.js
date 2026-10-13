import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });
import { createBot } from './bot.js';
import { initBotDb } from './lib/db.js';
import { startAlertsJob } from './lib/alertsJob.js';
import { startSniperJob } from './lib/sniper.js';
import { startLimitWatcher } from './lib/limitWatcher.js';
import { startAutoSellWatcher } from './lib/autoSellWatcher.js';
import { startDepositMonitor } from './monitor.js';
import { startReferralPayoutReconciler } from './lib/referralPayouts.js';
import { initWalletTradeJournal } from './lib/walletTradeJournal.js';
import { startWalletFeeCollector } from './lib/walletTrading.js';
import { validateConfig, FEE_RECEIVER, BOT_USERNAME } from './config.js';

async function main() {
  console.log('[Buzzo Bot] Starting...');
  validateConfig();
  process.env.BUZZO_BOT_FEE_WALLET = FEE_RECEIVER;
  await initBotDb();
  await initWalletTradeJournal();

  const bot = createBot();
  const identity = await bot.telegram.getMe();
  if (identity.username?.toLowerCase() !== BOT_USERNAME.toLowerCase())
    throw new Error('Telegram token is for a different bot.');

  startAlertsJob(bot);
  startSniperJob(bot);
  startLimitWatcher(bot);
  startAutoSellWatcher(bot);
  startDepositMonitor(bot.telegram);
  startReferralPayoutReconciler();
  startWalletFeeCollector();

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  await bot.launch({}, () => console.log('[Buzzo Bot] Running @Buzzotrade_bot on BSC mainnet'));
}

main().catch(e => {
  console.error('[Buzzo Bot] Fatal: startup failed. Run the preflight check; secret values are not logged.');
  process.exit(1);
});
