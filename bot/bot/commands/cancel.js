import { getPool } from '../lib/db.js';

export async function handleCancel(ctx) {
  const telegramId = ctx.from.id;
  try {
    const db = await getPool().getConnection();
    let counts;
    try {
      await db.beginTransaction();
      counts = [];
      for (const table of ['bot_snipes','bot_limit_orders','bot_autosell_orders']) {
        const [result] = await db.execute(`UPDATE ${table} SET status='cancelled' WHERE telegram_id=? AND status='pending'`,[telegramId]);
        counts.push(result.affectedRows);
      }
      const [alerts] = await db.execute('UPDATE bot_alerts SET triggered=1 WHERE telegram_id=? AND triggered=0',[telegramId]);
      counts.push(alerts.affectedRows);
      await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
    await ctx.reply(`✅ Cancelled ${counts[0]} snipe(s), ${counts[1]} limit order(s), ${counts[2]} auto-sell order(s) and ${counts[3]} alert(s).\nAlready submitted transactions cannot be cancelled.`);
  } catch (e) {
    await ctx.reply('Could not cancel orders. Please try again.');
  }
}
