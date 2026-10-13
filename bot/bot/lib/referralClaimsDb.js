import { getPool } from './db.js';
export async function getActivePayout() {
  const [[row]] = await getPool().execute(`SELECT p.* FROM bot_referral_payout_lock l
    JOIN bot_referral_payouts p ON p.id=l.active_id WHERE l.id=1`);
  return row || null;
}
export async function outstandingReferralBnb() {
  const [[row]] = await getPool().execute(`SELECT
    (SELECT COALESCE(SUM(claimable_bnb),0) FROM bot_referral_rewards) +
    (SELECT COALESCE(SUM(reserved_bnb),0) FROM bot_referral_payouts WHERE status IN ('reserved','signed','pending')) AS amount`);
  return String(row.amount);
}
export async function reserveReferralPayout(userId, recipient, treasury) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[lease]] = await connection.execute('SELECT active_id FROM bot_referral_payout_lock WHERE id=1 FOR UPDATE');
    if (lease.active_id) {
      const [[active]] = await connection.execute('SELECT * FROM bot_referral_payouts WHERE id=?', [lease.active_id]);
      await connection.commit(); return { active, created: false };
    }
    const [[reward]] = await connection.execute(
      'SELECT claimable_bnb FROM bot_referral_rewards WHERE telegram_id=? FOR UPDATE', [userId]);
    if (!reward || Number(reward.claimable_bnb) <= 0) {
      await connection.commit(); return { active: null, created: false };
    }
    const amount = String(reward.claimable_bnb);
    const [insert] = await connection.execute(`INSERT INTO bot_referral_payouts
      (telegram_id,recipient,treasury,reserved_bnb) VALUES (?,?,?,?)`, [userId,recipient,treasury,amount]);
    await connection.execute(`UPDATE bot_referral_rewards SET claimable_bnb=claimable_bnb-? WHERE telegram_id=?`, [amount,userId]);
    await connection.execute('UPDATE bot_referral_payout_lock SET active_id=? WHERE id=1', [insert.insertId]);
    const [[active]] = await connection.execute('SELECT * FROM bot_referral_payouts WHERE id=?', [insert.insertId]);
    await connection.commit(); return { active, created: true };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
export async function saveSignedPayout(id, data) {
  const [result] = await getPool().execute(`UPDATE bot_referral_payouts SET
    tx_hash=?, encrypted_raw=?, net_wei=?,gas_price=?,gas_limit=?,nonce=?,status='signed'
    WHERE id=? AND status='reserved'`,
    [data.hash,data.encryptedRaw,String(data.netWei),String(data.gasPrice),String(data.gasLimit),data.nonce,id]);
  if (result.affectedRows !== 1) throw new Error('Claim signing state changed; no broadcast allowed');
}
export async function markPayoutPending(id) {
  await getPool().execute("UPDATE bot_referral_payouts SET status='pending' WHERE id=? AND status='signed'", [id]);
}
export async function finishReferralPayout(id, success, refundBnb = '0', unsignedOnly = false) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('SELECT active_id FROM bot_referral_payout_lock WHERE id=1 FOR UPDATE');
    const [[row]] = await connection.execute('SELECT * FROM bot_referral_payouts WHERE id=? FOR UPDATE', [id]);
    if (!row) throw new Error('Missing claim journal');
    if (['completed','failed'].includes(row.status)) { await connection.commit(); return; }
    if (unsignedOnly && row.status !== 'reserved') { await connection.commit(); return; }
    if (success) {
      if (!row.tx_hash || row.net_wei == null) throw new Error('Unsigned payout cannot complete');
      await connection.execute(`UPDATE bot_referral_rewards SET
        claimable_bnb=claimable_bnb+?,claimed_bnb=claimed_bnb+?-? WHERE telegram_id=?`,
        [refundBnb,row.reserved_bnb,refundBnb,row.telegram_id]);
      await connection.execute(`INSERT INTO bot_referral_claims
        (telegram_id,amount_bnb,tx_hash,status) VALUES (?,?,?,'completed')`,
        [row.telegram_id,row.reserved_bnb,row.tx_hash]);
    } else {
      await connection.execute('UPDATE bot_referral_rewards SET claimable_bnb=claimable_bnb+? WHERE telegram_id=?',
        [row.reserved_bnb,row.telegram_id]);
    }
    await connection.execute('UPDATE bot_referral_payouts SET status=? WHERE id=?', [success ? 'completed':'failed',id]);
    await connection.execute('UPDATE bot_referral_payout_lock SET active_id=NULL WHERE id=1 AND active_id=?', [id]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
