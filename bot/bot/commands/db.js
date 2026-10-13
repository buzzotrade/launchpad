import mysql from 'mysql2/promise';

let pool;

function getPool() {
  if (pool) return pool;
  const url = process.env.BUZZO_BOT_DATABASE_URL;
  if (!url) throw new Error('BUZZO_BOT_DATABASE_URL not set');
  pool = mysql.createPool(url);
  return pool;
}

export async function initBotDb() {
  const db = getPool();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_id   BIGINT PRIMARY KEY,
      username      VARCHAR(100),
      wallet_address VARCHAR(42),
      slippage      INT DEFAULT 0,
      anti_mev      TINYINT(1) DEFAULT 0,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migrate: add anti_mev if it didn't exist yet
  await db.execute(`
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS anti_mev TINYINT(1) DEFAULT 0
  `).catch(() => {});
  // Migrate: reset slippage=10 (old system default) to 0 (auto)
  await db.execute(`UPDATE bot_users SET slippage = 0 WHERE slippage = 10`).catch(() => {});
  // Migrate: add gas_mode column
  await db.execute(`
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS gas_mode VARCHAR(20) DEFAULT 'medium'
  `).catch(() => {});
  // Migrate: add global trade settings columns
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS pre_approve_gas DECIMAL(10,4) DEFAULT 0.05`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS transfer_gas    DECIMAL(10,4) DEFAULT 0.05`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS sniper_slippage DECIMAL(10,4) DEFAULT 50`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS sniper_gas      DECIMAL(10,4) DEFAULT 3`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS snipe_min_liq   DECIMAL(10,4) DEFAULT 0.05`).catch(() => {});
  // Per-mode slippage and gas (null = fall back to global)
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS swap_slippage  INT           DEFAULT NULL`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS swap_gas_mode  VARCHAR(20)   DEFAULT NULL`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS limit_slippage INT           DEFAULT NULL`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS limit_gas_mode VARCHAR(20)   DEFAULT NULL`).catch(() => {});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_snipes (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id BIGINT,
      ca          VARCHAR(42),
      amount_bnb  DECIMAL(18,8),
      status      VARCHAR(20) DEFAULT 'pending',
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_alerts (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id       BIGINT,
      ca                VARCHAR(42),
      target_multiplier DECIMAL(10,4),
      entry_price       DECIMAL(30,18),
      triggered         TINYINT(1) DEFAULT 0,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_trades (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id BIGINT,
      ca          VARCHAR(42),
      direction   VARCHAR(4),
      amount_bnb  DECIMAL(18,8),
      fee_bnb     DECIMAL(18,8),
      tx_hash     VARCHAR(66),
      status      VARCHAR(20),
      price_usd   DECIMAL(30,12) DEFAULT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS price_usd DECIMAL(30,12) DEFAULT NULL`).catch(() => {});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_wallets (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      name         VARCHAR(50) NOT NULL,
      address      VARCHAR(42) NOT NULL,
      encrypted_pk TEXT NOT NULL,
      wallet_type  ENUM('hd','generated','imported') DEFAULT 'hd',
      is_default   TINYINT(1) DEFAULT 0,
      is_manual    TINYINT(1) DEFAULT 1,
      sort_order   INT DEFAULT 0,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_limit_orders (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id    BIGINT NOT NULL,
      ca             VARCHAR(42) NOT NULL,
      side           ENUM('buy','sell') NOT NULL,
      amount         DECIMAL(18,8) NOT NULL,
      trigger_price  DECIMAL(30,18) NOT NULL,
      original_input VARCHAR(30),
      status         ENUM('pending','triggered','cancelled','failed') DEFAULT 'pending',
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Custom buy/sell amounts
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_buy_1  DECIMAL(18,6) DEFAULT 0.02`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_buy_2  DECIMAL(18,6) DEFAULT 0.05`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_buy_3  DECIMAL(18,6) DEFAULT 0.1`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_buy_4  DECIMAL(18,6) DEFAULT 0.5`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_buy_5  DECIMAL(18,6) DEFAULT 1`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_sell_1 DECIMAL(6,2)  DEFAULT 25`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_sell_2 DECIMAL(6,2)  DEFAULT 50`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_sell_3 DECIMAL(6,2)  DEFAULT 100`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_sell_4 DECIMAL(6,2)  DEFAULT NULL`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS custom_sell_5 DECIMAL(6,2)  DEFAULT NULL`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS autosell_enabled TINYINT(1) DEFAULT 0`).catch(() => {});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_autosell_rules (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      trigger_pct  DECIMAL(8,2) NOT NULL,
      sell_pct     DECIMAL(6,2) NOT NULL,
      \`trailing\`   TINYINT(1) DEFAULT 0,
      enabled      TINYINT(1) DEFAULT 1,
      sort_order   INT DEFAULT 0,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_autosell_orders (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id    BIGINT NOT NULL,
      ca             VARCHAR(42) NOT NULL,
      wallet_address VARCHAR(42) NOT NULL,
      buy_price_usd  DECIMAL(30,12) NOT NULL,
      token_amount   DECIMAL(30,8) NOT NULL,
      trigger_pct    DECIMAL(8,2) NOT NULL,
      sell_pct       DECIMAL(6,2) NOT NULL,
      \`trailing\`    TINYINT(1) DEFAULT 0,
      peak_price_usd DECIMAL(30,12) DEFAULT NULL,
      status         ENUM('pending','triggered','cancelled','failed') DEFAULT 'pending',
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'en'`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS referred_by BIGINT DEFAULT NULL`).catch(() => {});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_referrals (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      referrer_id  BIGINT NOT NULL,
      invitee_id   BIGINT NOT NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_invitee (invitee_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_referral_rewards (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id  BIGINT NOT NULL UNIQUE,
      total_bnb    DECIMAL(18,8) DEFAULT 0,
      claimable_bnb DECIMAL(18,8) DEFAULT 0,
      claimed_bnb  DECIMAL(18,8) DEFAULT 0,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_referral_claims (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      amount_bnb   DECIMAL(18,8) NOT NULL,
      tx_hash      VARCHAR(66),
      status       VARCHAR(20) DEFAULT 'completed',
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('[BotDB] MySQL tables ready');
}

export async function getUser(telegramId) {
  const db = getPool();
  const [rows] = await db.execute('SELECT * FROM bot_users WHERE telegram_id = ?', [telegramId]);
  return rows[0] || null;
}

export async function createUser(telegramId, username, walletAddress) {
  const db = getPool();
  await db.execute(
    `INSERT INTO bot_users (telegram_id, username, wallet_address)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE username = VALUES(username)`,
    [telegramId, username, walletAddress]
  );
  return getUser(telegramId);
}

export async function getUserLanguage(telegramId) {
  const db = getPool();
  const [rows] = await db.execute('SELECT language FROM bot_users WHERE telegram_id = ?', [telegramId]);
  return rows[0]?.language || 'en';
}

export async function setUserLanguage(telegramId, lang) {
  const db = getPool();
  await db.execute('UPDATE bot_users SET language = ? WHERE telegram_id = ?', [lang, telegramId]);
}

export async function saveTrade(telegramId, ca, direction, amountBnb, feeBnb, txHash, status, priceUsd = null) {
  const db = getPool();
  await db.execute(
    `INSERT INTO bot_trades (telegram_id, ca, direction, amount_bnb, fee_bnb, tx_hash, status, price_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [telegramId, ca, direction, amountBnb, feeBnb, txHash, status, priceUsd || null]
  );
}

export async function createSnipe(telegramId, ca, amountBnb) {
  const db = getPool();
  const [result] = await db.execute(
    `INSERT INTO bot_snipes (telegram_id, ca, amount_bnb) VALUES (?, ?, ?)`,
    [telegramId, ca, amountBnb]
  );
  const [rows] = await db.execute('SELECT * FROM bot_snipes WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function getPendingSnipes() {
  const db = getPool();
  const [rows] = await db.execute(`SELECT * FROM bot_snipes WHERE status = 'pending'`);
  return rows;
}

export async function updateSnipeStatus(id, status) {
  const db = getPool();
  await db.execute(`UPDATE bot_snipes SET status = ? WHERE id = ?`, [status, id]);
}

export async function createAlert(telegramId, ca, targetMultiplier, entryPrice) {
  const db = getPool();
  const [result] = await db.execute(
    `INSERT INTO bot_alerts (telegram_id, ca, target_multiplier, entry_price) VALUES (?, ?, ?, ?)`,
    [telegramId, ca, targetMultiplier, entryPrice]
  );
  const [rows] = await db.execute('SELECT * FROM bot_alerts WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function getPendingAlerts() {
  const db = getPool();
  const [rows] = await db.execute(`SELECT * FROM bot_alerts WHERE triggered = 0`);
  return rows;
}

export async function triggerAlert(id) {
  const db = getPool();
  await db.execute(`UPDATE bot_alerts SET triggered = 1 WHERE id = ?`, [id]);
}

export async function cancelUserSnipes(telegramId) {
  const db = getPool();
  const [result] = await db.execute(
    `UPDATE bot_snipes SET status = 'cancelled' WHERE telegram_id = ? AND status = 'pending'`,
    [telegramId]
  );
  return result.affectedRows;
}

export async function getAvgBuyPrice(telegramId, ca) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT SUM(amount_bnb) as total_bnb, COUNT(*) as trades,
            SUM(price_usd * amount_bnb) / NULLIF(SUM(CASE WHEN price_usd IS NOT NULL THEN amount_bnb ELSE 0 END), 0) as avg_price_usd
     FROM bot_trades WHERE telegram_id = ? AND ca = ? AND direction = 'buy' AND status = 'success'`,
    [telegramId, ca]
  );
  return rows[0] || { total_bnb: 0, trades: 0, avg_price_usd: null };
}

export async function getUserTradeHistory(telegramId, limit = 20) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT ca, direction, amount_bnb, fee_bnb, tx_hash, status, price_usd, created_at
     FROM bot_trades WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?`,
    [telegramId, limit]
  );
  return rows;
}

export async function getTradedCAs(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT DISTINCT ca FROM bot_trades WHERE telegram_id = ? AND direction = 'buy' AND status = 'success'`,
    [telegramId]
  );
  return rows.map(r => r.ca);
}

const ALLOWED_SETTINGS = new Set([
  'slippage', 'gas_mode', 'pre_approve_gas', 'transfer_gas',
  'sniper_slippage', 'sniper_gas', 'snipe_min_liq',
  'swap_slippage', 'swap_gas_mode', 'limit_slippage', 'limit_gas_mode',
]);

export async function updateUserSetting(telegramId, key, value) {
  if (!ALLOWED_SETTINGS.has(key)) throw new Error(`Unknown setting: ${key}`);
  const db = getPool();
  await db.execute(`UPDATE bot_users SET \`${key}\` = ? WHERE telegram_id = ?`, [value, telegramId]);
}

export async function updateGasMode(telegramId, gasMode) {
  const db = getPool();
  await db.execute(`UPDATE bot_users SET gas_mode = ? WHERE telegram_id = ?`, [gasMode, telegramId]);
}

export async function updateAntiMev(telegramId, enabled) {
  const db = getPool();
  await db.execute(`UPDATE bot_users SET anti_mev = ? WHERE telegram_id = ?`, [enabled ? 1 : 0, telegramId]);
}

export async function updateSlippage(telegramId, slippage) {
  const db = getPool();
  await db.execute(`UPDATE bot_users SET slippage = ? WHERE telegram_id = ?`, [slippage, telegramId]);
}

export async function cancelUserAlerts(telegramId) {
  const db = getPool();
  const [result] = await db.execute(
    `UPDATE bot_alerts SET triggered = 1 WHERE telegram_id = ? AND triggered = 0`,
    [telegramId]
  );
  return result.affectedRows;
}

// ─── Multi-Wallets ────────────────────────────────────────────────────────────

export async function getUserWallets(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_wallets WHERE telegram_id = ? ORDER BY sort_order ASC, id ASC`,
    [telegramId]
  );
  return rows;
}

export async function getWallet(telegramId, walletId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_wallets WHERE id = ? AND telegram_id = ?`,
    [walletId, telegramId]
  );
  return rows[0] || null;
}

export async function getDefaultWallet(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_wallets WHERE telegram_id = ? AND is_default = 1 LIMIT 1`,
    [telegramId]
  );
  return rows[0] || null;
}

export async function countUserWallets(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT COUNT(*) as cnt FROM bot_wallets WHERE telegram_id = ?`,
    [telegramId]
  );
  return rows[0].cnt;
}

export async function createWalletRecord(telegramId, name, address, encryptedPk, walletType, makeDefault = false) {
  const db = getPool();
  if (makeDefault) {
    await db.execute(`UPDATE bot_wallets SET is_default = 0 WHERE telegram_id = ?`, [telegramId]);
  }
  const [rows] = await db.execute(
    `SELECT MAX(sort_order) as maxOrder FROM bot_wallets WHERE telegram_id = ?`,
    [telegramId]
  );
  const nextOrder = (rows[0].maxOrder || 0) + 1;
  const [result] = await db.execute(
    `INSERT INTO bot_wallets (telegram_id, name, address, encrypted_pk, wallet_type, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [telegramId, name, address, encryptedPk, walletType, makeDefault ? 1 : 0, nextOrder]
  );
  const [newRows] = await db.execute(`SELECT * FROM bot_wallets WHERE id = ?`, [result.insertId]);
  return newRows[0];
}

export async function setDefaultWallet(telegramId, walletId) {
  const db = getPool();
  await db.execute(`UPDATE bot_wallets SET is_default = 0 WHERE telegram_id = ?`, [telegramId]);
  await db.execute(`UPDATE bot_wallets SET is_default = 1 WHERE id = ? AND telegram_id = ?`, [walletId, telegramId]);
}

export async function toggleManualWallet(telegramId, walletId) {
  const db = getPool();
  await db.execute(
    `UPDATE bot_wallets SET is_manual = NOT is_manual WHERE id = ? AND telegram_id = ?`,
    [walletId, telegramId]
  );
}

export async function renameWallet(telegramId, walletId, newName) {
  const db = getPool();
  await db.execute(
    `UPDATE bot_wallets SET name = ? WHERE id = ? AND telegram_id = ?`,
    [newName, walletId, telegramId]
  );
}

export async function isWalletNameTaken(telegramId, name, excludeWalletId = null) {
  const db = getPool();
  let query = `SELECT id FROM bot_wallets WHERE telegram_id = ? AND LOWER(name) = LOWER(?)`;
  const params = [telegramId, name];
  if (excludeWalletId) {
    query += ` AND id != ?`;
    params.push(excludeWalletId);
  }
  const [rows] = await db.execute(query, params);
  return rows.length > 0;
}

export async function deleteWallet(telegramId, walletId) {
  const db = getPool();
  const [result] = await db.execute(
    `DELETE FROM bot_wallets WHERE id = ? AND telegram_id = ? AND is_default = 0`,
    [walletId, telegramId]
  );
  return result.affectedRows;
}

// ─── Limit Orders ─────────────────────────────────────────────────────────────

export async function createLimitOrder(telegramId, ca, side, amount, triggerPrice, originalInput) {
  const db = getPool();
  const [result] = await db.execute(
    `INSERT INTO bot_limit_orders (telegram_id, ca, side, amount, trigger_price, original_input)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [telegramId, ca, side, amount, triggerPrice, originalInput]
  );
  const [rows] = await db.execute('SELECT * FROM bot_limit_orders WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function getPendingLimitOrders() {
  const db = getPool();
  const [rows] = await db.execute(`SELECT * FROM bot_limit_orders WHERE status = 'pending'`);
  return rows;
}

export async function getUserLimitOrders(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_limit_orders WHERE telegram_id = ? AND status IN ('pending') ORDER BY created_at DESC`,
    [telegramId]
  );
  return rows;
}

export async function updateLimitOrderStatus(id, status) {
  const db = getPool();
  await db.execute(`UPDATE bot_limit_orders SET status = ? WHERE id = ?`, [status, id]);
}

export async function cancelLimitOrder(id, telegramId) {
  const db = getPool();
  const [result] = await db.execute(
    `UPDATE bot_limit_orders SET status = 'cancelled' WHERE id = ? AND telegram_id = ? AND status = 'pending'`,
    [id, telegramId]
  );
  return result.affectedRows;
}

export async function cancelAllLimitOrders(telegramId) {
  const db = getPool();
  const [result] = await db.execute(
    `UPDATE bot_limit_orders SET status = 'cancelled' WHERE telegram_id = ? AND status = 'pending'`,
    [telegramId]
  );
  return result.affectedRows;
}

// ── Custom buy/sell amounts ───────────────────────────────────────────────────
export function getCustomBuys(user) {
  return [
    user?.custom_buy_1 ?? 0.02,
    user?.custom_buy_2 ?? 0.05,
    user?.custom_buy_3 ?? 0.1,
    user?.custom_buy_4 ?? 0.5,
    user?.custom_buy_5 ?? 1,
  ].map(Number).filter(v => v > 0);
}

export function getCustomSells(user) {
  return [
    user?.custom_sell_1 ?? 25,
    user?.custom_sell_2 ?? 50,
    user?.custom_sell_3 ?? 100,
    user?.custom_sell_4 ?? null,
    user?.custom_sell_5 ?? null,
  ].map(v => v !== null ? Number(v) : null).filter(v => v !== null && v > 0);
}

export async function setCustomBuySlot(telegramId, slot, value) {
  const db = getPool();
  await db.execute(`UPDATE bot_users SET \`custom_buy_${slot}\` = ? WHERE telegram_id = ?`, [value || null, telegramId]);
}

export async function setCustomSellSlot(telegramId, slot, value) {
  const db = getPool();
  await db.execute(`UPDATE bot_users SET \`custom_sell_${slot}\` = ? WHERE telegram_id = ?`, [value || null, telegramId]);
}

// ── Auto Sell rules ───────────────────────────────────────────────────────────
export async function getAutoSellRules(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_autosell_rules WHERE telegram_id = ? ORDER BY sort_order ASC, id ASC`,
    [telegramId]
  );
  return rows;
}

export async function createAutoSellRule(telegramId, triggerPct, sellPct, trailing = 0) {
  const db = getPool();
  const [result] = await db.execute(
    `INSERT INTO bot_autosell_rules (telegram_id, trigger_pct, sell_pct, \`trailing\`) VALUES (?, ?, ?, ?)`,
    [telegramId, triggerPct, sellPct, trailing ? 1 : 0]
  );
  return result.insertId;
}

export async function toggleAutoSellRule(ruleId, telegramId) {
  const db = getPool();
  await db.execute(
    `UPDATE bot_autosell_rules SET enabled = 1 - enabled WHERE id = ? AND telegram_id = ?`,
    [ruleId, telegramId]
  );
}

export async function deleteAutoSellRule(ruleId, telegramId) {
  const db = getPool();
  await db.execute(`DELETE FROM bot_autosell_rules WHERE id = ? AND telegram_id = ?`, [ruleId, telegramId]);
}

export async function setUserAutoSell(telegramId, enabled) {
  const db = getPool();
  await db.execute(`UPDATE bot_users SET autosell_enabled = ? WHERE telegram_id = ?`, [enabled ? 1 : 0, telegramId]);
}

// ── Auto Sell orders (created after a buy when rules are active) ──────────────
export async function createAutoSellOrders(telegramId, ca, walletAddress, buyPriceUsd, tokenAmount) {
  const rules = await getAutoSellRules(telegramId);
  const active = rules.filter(r => r.enabled);
  if (!active.length) return 0;
  const db = getPool();
  let count = 0;
  for (const rule of active) {
    await db.execute(
      `INSERT INTO bot_autosell_orders
       (telegram_id, ca, wallet_address, buy_price_usd, token_amount, trigger_pct, sell_pct, \`trailing\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [telegramId, ca, walletAddress, buyPriceUsd, tokenAmount, rule.trigger_pct, rule.sell_pct, rule.trailing]
    );
    count++;
  }
  return count;
}

export async function getPendingAutoSellOrders() {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_autosell_orders WHERE status = 'pending' ORDER BY id ASC`
  );
  return rows;
}

export async function updateAutoSellOrderPeak(orderId, peakPriceUsd) {
  const db = getPool();
  await db.execute(`UPDATE bot_autosell_orders SET peak_price_usd = ? WHERE id = ?`, [peakPriceUsd, orderId]);
}

export async function updateAutoSellOrderStatus(orderId, status) {
  const db = getPool();
  await db.execute(`UPDATE bot_autosell_orders SET status = ? WHERE id = ?`, [status, orderId]);
}

export async function cancelAutoSellOrders(telegramId, ca) {
  const db = getPool();
  await db.execute(
    `UPDATE bot_autosell_orders SET status = 'cancelled' WHERE telegram_id = ? AND ca = ? AND status = 'pending'`,
    [telegramId, ca]
  );
}

export async function getAllWallets() {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT w.id, w.telegram_id, w.address, w.name, w.is_default FROM bot_wallets w ORDER BY w.id ASC`
  );
  return rows;
}

export async function setReferredBy(inviteeId, referrerId) {
  if (inviteeId === referrerId) return;
  const db = getPool();
  await db.execute(
    `UPDATE bot_users SET referred_by = ? WHERE telegram_id = ? AND referred_by IS NULL`,
    [referrerId, inviteeId]
  );
  await db.execute(
    `INSERT IGNORE INTO bot_referrals (referrer_id, invitee_id) VALUES (?, ?)`,
    [referrerId, inviteeId]
  );
}

export async function getReferralStats(telegramId) {
  const db = getPool();
  const [[reward]] = await db.execute(
    `SELECT total_bnb, claimable_bnb, claimed_bnb FROM bot_referral_rewards WHERE telegram_id = ?`,
    [telegramId]
  );
  const [[{ count }]] = await db.execute(
    `SELECT COUNT(*) AS count FROM bot_referrals WHERE referrer_id = ?`,
    [telegramId]
  );
  return {
    total_bnb:     reward?.total_bnb || 0,
    claimable_bnb: reward?.claimable_bnb || 0,
    claimed_bnb:   reward?.claimed_bnb || 0,
    count:         count || 0,
  };
}

export async function getReferralInvitees(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT r.invitee_id, u.username, r.created_at
     FROM bot_referrals r
     LEFT JOIN bot_users u ON u.telegram_id = r.invitee_id
     WHERE r.referrer_id = ? ORDER BY r.created_at DESC`,
    [telegramId]
  );
  return rows;
}

const REFERRAL_REWARD_PCT = 0.003; // 0.3% of trade BNB (separate from 1% platform fee)
const REFERRAL_EXPIRY_MONTHS = 6;

export async function creditReferralReward(inviteeId, tradeBnb = 0) {
  if (tradeBnb <= 0) return;
  const db = getPool();
  const [[user]] = await db.execute(
    `SELECT referred_by FROM bot_users WHERE telegram_id = ?`,
    [inviteeId]
  );
  if (!user?.referred_by) return;
  const referrerId = user.referred_by;

  const [[ref]] = await db.execute(
    `SELECT created_at FROM bot_referrals WHERE referrer_id = ? AND invitee_id = ?`,
    [referrerId, inviteeId]
  );
  if (!ref) return;
  const monthsAgo = (Date.now() - new Date(ref.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (monthsAgo > REFERRAL_EXPIRY_MONTHS) return;

  const rewardBnb = parseFloat((tradeBnb * REFERRAL_REWARD_PCT).toFixed(8));
  await db.execute(
    `INSERT INTO bot_referral_rewards (telegram_id, total_bnb, claimable_bnb)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_bnb     = total_bnb     + VALUES(total_bnb),
       claimable_bnb = claimable_bnb + VALUES(claimable_bnb)`,
    [referrerId, rewardBnb, rewardBnb]
  );
}

export async function claimReferralReward(telegramId, amountBnb, txHash) {
  const db = getPool();
  await db.execute(
    `UPDATE bot_referral_rewards SET claimable_bnb = 0, claimed_bnb = claimed_bnb + ? WHERE telegram_id = ?`,
    [amountBnb, telegramId]
  );
  await db.execute(
    `INSERT INTO bot_referral_claims (telegram_id, amount_bnb, tx_hash) VALUES (?, ?, ?)`,
    [telegramId, amountBnb, txHash]
  );
}

export async function getReferralClaims(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_referral_claims WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 20`,
    [telegramId]
  );
  return rows;
}
