import 'dotenv/config';
import { initBotDb } from '../bot/lib/db.js';
const url = new URL(process.env.BUZZO_BOT_DATABASE_URL || 'mysql://localhost/invalid');
if (url.protocol !== 'mysql:' || url.pathname !== '/buzzo_bot')
  throw new Error('Schema initialization is restricted to the dedicated buzzo_bot database.');
try {
  await initBotDb();
  console.log('Buzzo bot schema initialized. No legacy data imported.');
  process.exit(0);
} catch {
  console.error('Buzzo bot schema initialization failed. Credentials and SQL parameters are not logged.');
  process.exit(1);
}
