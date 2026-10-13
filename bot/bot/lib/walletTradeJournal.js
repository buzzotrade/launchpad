import { getPool } from './db.js';
import { encryptKey } from './walletLib.js';
import { ethers } from 'ethers';

export async function initWalletTradeJournal() {
  await getPool().execute(`CREATE TABLE IF NOT EXISTS bot_wallet_transactions (
    tx_hash VARCHAR(66) PRIMARY KEY, wallet VARCHAR(42) NOT NULL, telegram_id BIGINT NOT NULL,
    kind VARCHAR(12) NOT NULL, status VARCHAR(12) DEFAULT 'pending',
    meta JSON NOT NULL, encrypted_raw MEDIUMTEXT NOT NULL, INDEX wallet_status(wallet,status))`);
  await getPool().execute(`CREATE TABLE IF NOT EXISTS bot_wallet_fee_debts (
    trade_hash VARCHAR(66) PRIMARY KEY, wallet VARCHAR(42) NOT NULL, telegram_id BIGINT NOT NULL,
    platform_wei VARCHAR(80) NOT NULL, referral_wei VARCHAR(80) NOT NULL, referrer_id BIGINT,
    collection_hash VARCHAR(66), paid TINYINT DEFAULT 0, INDEX wallet_paid(wallet,paid))`);
}
export const journal = {
  async save(hash, wallet, telegramId, kind, meta, raw) {
    await getPool().execute(`INSERT INTO bot_wallet_transactions
      (tx_hash,wallet,telegram_id,kind,meta,encrypted_raw) VALUES (?,?,?,?,?,?)`,
    [hash, wallet, telegramId, kind, JSON.stringify(meta), encryptKey(raw)]);
  },
  async pending(wallet) {
    const [rows] = await getPool().execute(`SELECT * FROM bot_wallet_transactions WHERE wallet=? AND status='pending'`, [wallet]);
    return rows.map(r => ({ ...r, meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta }));
  },
  async finish(row, success, fees = null) {
    const c = await getPool().getConnection();
    try {
      await c.beginTransaction();
      const [[locked]] = await c.execute(`SELECT status FROM bot_wallet_transactions WHERE tx_hash=? FOR UPDATE`, [row.tx_hash]);
      if (locked?.status === 'pending') {
        if (success && row.kind === 'swap' && fees) {
          await c.execute(`INSERT IGNORE INTO bot_wallet_fee_debts
            (trade_hash,wallet,telegram_id,platform_wei,referral_wei,referrer_id) VALUES (?,?,?,?,?,?)`,
          [row.tx_hash, row.wallet, row.telegram_id, fees.platform.toString(), fees.referral.toString(), row.meta.policy.referrerId || null]);
        }
        if (row.kind === 'fee' && success) {
          // Credit referrals only after the fee payment is confirmed, exactly once.
          for (const debt of row.meta.debts) {
            if (debt.referrer_id && BigInt(debt.referral_wei) > 0n) {
              const reward = ethers.formatEther(debt.referral_wei);
              await c.execute(`INSERT INTO bot_referral_rewards (telegram_id,total_bnb,claimable_bnb)
                VALUES (?,?,?) ON DUPLICATE KEY UPDATE total_bnb=total_bnb+VALUES(total_bnb),claimable_bnb=claimable_bnb+VALUES(claimable_bnb)`,
              [debt.referrer_id, reward, reward]);
            }
            await c.execute(`UPDATE bot_wallet_fee_debts SET paid=1,collection_hash=? WHERE trade_hash=? AND paid=0`,
              [row.tx_hash, debt.trade_hash]);
          }
        }
        await c.execute(`UPDATE bot_wallet_transactions SET status=? WHERE tx_hash=?`,
          [success ? 'confirmed' : 'failed', row.tx_hash]);
      }
      await c.commit();
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  },
  async debts(wallet, tid) {
    const [rows] = await getPool().execute(`SELECT * FROM bot_wallet_fee_debts WHERE wallet=? AND telegram_id=? AND paid=0`, [wallet, tid]);
    return rows;
  },
  async wallets() {
    const [rows] = await getPool().execute(`SELECT DISTINCT w.* FROM bot_wallets w
      LEFT JOIN bot_wallet_fee_debts d ON LOWER(d.wallet)=LOWER(w.address) AND d.telegram_id=w.telegram_id
      LEFT JOIN bot_wallet_transactions t ON LOWER(t.wallet)=LOWER(w.address) AND t.telegram_id=w.telegram_id
      WHERE (d.paid=0 OR t.status='pending') AND w.deleted_at IS NULL`);
    return rows;
  },
};
