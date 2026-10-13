import { getPool,getUserByUsername,getDefaultWallet } from './db.js';
import { deriveUserWallet,encryptKey } from './walletLib.js';
export async function tipRecipientWallet({ id,username,telegram }) {
  let user;
  if (id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid Telegram ID');
    const derived = deriveUserWallet(id);
    const db = await getPool().getConnection();
    try {
      await db.beginTransaction();
      await db.execute(`INSERT IGNORE INTO bot_users
        (telegram_id,username,wallet_address,notifications_enabled) VALUES (?,?,?,0)`,
        [id,username || null,derived.address]);
      const [[stored]] = await db.execute('SELECT * FROM bot_users WHERE telegram_id=? FOR UPDATE',[id]);
      user = stored;
      const [wallets] = await db.execute('SELECT * FROM bot_wallets WHERE telegram_id=?',[id]);
      // Never silently reactivate an archived wallet. Provision only a truly wallet-less account.
      if (!wallets.length) {
        await db.execute(`INSERT INTO bot_wallets
          (telegram_id,name,address,encrypted_pk,wallet_type,is_default,sort_order)
          VALUES (?,'Wallet 1',?,?,'hd',1,1)`,[id,derived.address,encryptKey(derived.privateKey)]);
      }
      await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
  } else {
    if (!username) return null;
    user = await getUserByUsername(username);
    if (!user) return null;
    // A database username can be stale/reassigned. Never pay it without live verification.
    try {
      const current = await telegram.getChat(user.telegram_id);
      if (Number(current.id) !== Number(user.telegram_id) ||
          current.username?.toLowerCase() !== username.toLowerCase()) return null;
    } catch { return null; }
  }
  const wallet = await getDefaultWallet(user.telegram_id);
  return wallet ? { user,wallet } : null;
}
