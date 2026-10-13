import mysql from 'mysql2/promise';
import { MAX_WALLETS } from '../config.js';

let pool;

export function getPool() {
  if (pool) return pool;
  const url = process.env.BUZZO_BOT_DATABASE_URL;
  if (!url) throw new Error('BUZZO_BOT_DATABASE_URL not set');
  pool = mysql.createPool(url);
  return pool;
}

export async function initBotDb() {
  const db = getPool();
  await db.execute(`CREATE TABLE IF NOT EXISTS bot_referral_payouts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, telegram_id BIGINT NOT NULL,
    recipient VARCHAR(42) NOT NULL, treasury VARCHAR(42) NOT NULL,
    reserved_bnb DECIMAL(18,8) NOT NULL, net_wei VARCHAR(80), gas_price VARCHAR(80),
    gas_limit VARCHAR(30), nonce BIGINT, tx_hash VARCHAR(66) UNIQUE,
    encrypted_raw MEDIUMTEXT, status VARCHAR(20) NOT NULL DEFAULT 'reserved',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX user_status (telegram_id,status)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS bot_referral_payout_lock (
    id INT PRIMARY KEY, active_id BIGINT DEFAULT NULL
  )`);
  await db.execute(`INSERT IGNORE INTO bot_referral_payout_lock (id) VALUES (1)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS bot_atomic_trades (
    tx_hash VARCHAR(66) PRIMARY KEY, wallet_address VARCHAR(42) NOT NULL,
    telegram_id BIGINT NOT NULL, referrer_id BIGINT DEFAULT NULL,
    status ENUM('pending','confirmed','failed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_id   BIGINT PRIMARY KEY,
      username      VARCHAR(100),
      wallet_address VARCHAR(42),
      slippage      INT DEFAULT 10,
      anti_mev      TINYINT(1) DEFAULT 0,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migrate: add anti_mev if it didn't exist yet
  await db.execute(`
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS anti_mev TINYINT(1) DEFAULT 0
  `).catch(() => {});
  // Change defaults only: never reset a user's saved slippage during startup.
  await db.execute(`ALTER TABLE bot_users ALTER COLUMN slippage SET DEFAULT 10`);
  // Migrate: add gas_mode column
  await db.execute(`
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS gas_mode VARCHAR(20) DEFAULT 'medium'
  `).catch(() => {});
  // Migrate: add global trade settings columns
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS manual_wallet_id BIGINT DEFAULT NULL`);
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS pre_approve_gas DECIMAL(10,4) DEFAULT 0.05`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS transfer_gas    DECIMAL(10,4) DEFAULT 0.05`).catch(() => {});
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS sniper_slippage DECIMAL(10,4) DEFAULT 10`);
  await db.execute(`ALTER TABLE bot_users ALTER COLUMN sniper_slippage SET DEFAULT 10`);
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
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at   TIMESTAMP NULL DEFAULT NULL
    )
  `);
  await db.execute(`ALTER TABLE bot_wallets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL DEFAULT NULL`);

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

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_tips (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      sender_id          BIGINT NOT NULL,
      sender_username    VARCHAR(100),
      sender_address     VARCHAR(42),
      recipient_id       BIGINT DEFAULT NULL,
      recipient_username VARCHAR(100),
      amount             DECIMAL(30,4) NOT NULL,
      status             ENUM('pending','completed','failed') DEFAULT 'pending',
      tx_hash            VARCHAR(66),
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at       TIMESTAMP NULL
    )
  `);
  // Migrate: add token columns for multi-token tip queue support
  await db.execute(`ALTER TABLE bot_tips ADD COLUMN IF NOT EXISTS token_ca     VARCHAR(42)  DEFAULT NULL`).catch(() => {});
  await db.execute(`ALTER TABLE bot_tips ADD COLUMN IF NOT EXISTS token_symbol VARCHAR(20)  DEFAULT 'BUZZO'`).catch(() => {});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_hidden_tokens (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      token_ca     VARCHAR(42) NOT NULL,
      UNIQUE KEY uniq_user_token (telegram_id, token_ca)
    )
  `);
  await db.execute(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS notifications_enabled TINYINT(1) NOT NULL DEFAULT 1`);
  for (const table of ['bot_snipes', 'bot_limit_orders', 'bot_alerts']) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS wallet_id INT DEFAULT NULL`);
    await db.execute(`UPDATE ${table} o JOIN bot_wallets w ON w.telegram_id = o.telegram_id
      AND w.is_default = 1 AND w.deleted_at IS NULL SET o.wallet_id = w.id WHERE o.wallet_id IS NULL`);
  }
  await db.execute("ALTER TABLE bot_alerts ADD COLUMN IF NOT EXISTS price_unit VARCHAR(12) NOT NULL DEFAULT 'legacy'");
  await db.execute('ALTER TABLE bot_alerts MODIFY entry_price DECIMAL(65,30)');
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

export async function createSnipe(telegramId, ca, amountBnb, walletId = null) {
  const db = getPool();
  if (!await canNotifyUser(telegramId)) throw new Error('Use /start to reconnect first.');
  const wallet = walletId ? await getWallet(telegramId, walletId) : await getDefaultWallet(telegramId);
  if (!wallet) throw new Error('Select an active wallet first.');
  const [result] = await db.execute(
    `INSERT INTO bot_snipes (telegram_id, ca, amount_bnb, wallet_id) VALUES (?, ?, ?, ?)`,
    [telegramId, ca, amountBnb, wallet.id]
  );
  const [rows] = await db.execute('SELECT * FROM bot_snipes WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function createSnipeBatch(telegramId, ca, amountBnb, walletIds) {
  const ids = [...new Set(walletIds)];
  if (!ids.length || ids.length > MAX_WALLETS) throw new Error('Select 1–11 active wallets.');
  const db = await getPool().getConnection();
  try {
    await db.beginTransaction();
    const [[user]] = await db.execute(`SELECT notifications_enabled FROM bot_users WHERE telegram_id=? FOR UPDATE`, [telegramId]);
    if (!user || !Number(user.notifications_enabled)) throw new Error('Use /start to reconnect first.');
    const [wallets] = await db.execute(`SELECT id FROM bot_wallets WHERE telegram_id=? AND deleted_at IS NULL
      AND id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, [telegramId, ...ids]);
    if (wallets.length !== ids.length) throw new Error('A selected wallet was removed. Refresh your selection.');
    const orders = [];
    for (const id of ids) {
      const [result] = await db.execute(`INSERT INTO bot_snipes (telegram_id,ca,amount_bnb,wallet_id) VALUES (?,?,?,?)`,
        [telegramId, ca, amountBnb, id]);
      orders.push({ id: result.insertId, wallet_id: id });
    }
    await db.commit();
    return orders;
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}

export async function getPendingSnipes() {
  const db = getPool();
  const [rows] = await db.execute(`SELECT s.* FROM bot_snipes s JOIN bot_users u ON u.telegram_id=s.telegram_id
    JOIN bot_wallets w ON w.id=s.wallet_id AND w.telegram_id=s.telegram_id
    WHERE s.status='pending' AND u.notifications_enabled=1 AND w.deleted_at IS NULL`);
  return rows;
}

export async function updateSnipeStatus(id, status) {
  const db = getPool();
  if (status === 'triggered') {
    const [result] = await db.execute(`UPDATE bot_snipes s JOIN bot_users u ON u.telegram_id=s.telegram_id
      JOIN bot_wallets w ON w.id=s.wallet_id AND w.telegram_id=s.telegram_id
      SET s.status='triggered' WHERE s.id=? AND s.status='pending'
      AND u.notifications_enabled=1 AND w.deleted_at IS NULL`, [id]);
    return result.affectedRows > 0;
  }
  await db.execute(`UPDATE bot_snipes SET status=? WHERE id=?`, [status, id]);
  return true;
}

export async function createAlert(telegramId, ca, targetMultiplier, entryPrice) {
  const db = getPool();
  if (!await canNotifyUser(telegramId)) throw new Error('Use /start to reconnect first.');
  const wallet = await getDefaultWallet(telegramId);
  if (!wallet) throw new Error('Select an active wallet first.');
  const [result] = await db.execute(
    `INSERT INTO bot_alerts (telegram_id, ca, target_multiplier, entry_price, wallet_id, price_unit) VALUES (?, ?, ?, ?, ?, 'bnb')`,
    [telegramId, ca, targetMultiplier, entryPrice, wallet.id]
  );
  const [rows] = await db.execute('SELECT * FROM bot_alerts WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function getPendingAlerts() {
  const db = getPool();
  const [rows] = await db.execute(`SELECT a.* FROM bot_alerts a JOIN bot_users u ON u.telegram_id=a.telegram_id
    JOIN bot_wallets w ON w.id=a.wallet_id AND w.telegram_id=a.telegram_id
    WHERE a.triggered=0 AND u.notifications_enabled=1 AND w.deleted_at IS NULL`);
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
    `SELECT * FROM bot_wallets WHERE telegram_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC`,
    [telegramId]
  );
  return rows;
}

export async function getWallet(telegramId, walletId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_wallets WHERE id = ? AND telegram_id = ? AND deleted_at IS NULL`,
    [walletId, telegramId]
  );
  return rows[0] || null;
}

export async function getDefaultWallet(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM bot_wallets WHERE telegram_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
    [telegramId]
  );
  return rows[0] || null;
}

export async function getManualWallet(telegramId) {
  const [rows] = await getPool().execute(
    `SELECT w.* FROM bot_wallets w JOIN bot_users u ON u.telegram_id=w.telegram_id
     WHERE w.telegram_id=? AND w.deleted_at IS NULL AND w.is_manual=1
     ORDER BY (w.id=u.manual_wallet_id) DESC,w.is_default DESC,w.sort_order ASC,w.id ASC LIMIT 1`,
    [telegramId]);
  return rows[0] || null;
}

export async function setManualWallet(telegramId, walletId) {
  const [result] = await getPool().execute(
    `UPDATE bot_users u JOIN bot_wallets w ON w.telegram_id=u.telegram_id
     SET u.manual_wallet_id=w.id
     WHERE u.telegram_id=? AND w.id=? AND w.deleted_at IS NULL AND w.is_manual=1`,
    [telegramId,walletId]);
  if (!result.affectedRows) throw new Error('Enable Manual on this wallet before selecting it.');
}

export async function countUserWallets(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT COUNT(*) as cnt FROM bot_wallets WHERE telegram_id = ? AND deleted_at IS NULL`,
    [telegramId]
  );
  return rows[0].cnt;
}

export async function createWalletRecord(telegramId, name, address, encryptedPk, walletType, makeDefault = false) {
  const db = await getPool().getConnection();
  try {
    await db.beginTransaction();
    const [users] = await db.execute(`SELECT telegram_id FROM bot_users WHERE telegram_id=? FOR UPDATE`, [telegramId]);
    if (!users.length) throw new Error('Use /start first.');
    const [[counts]] = await db.execute(`SELECT COUNT(*) AS cnt FROM bot_wallets WHERE telegram_id=? AND deleted_at IS NULL`, [telegramId]);
    if (Number(counts.cnt) >= MAX_WALLETS) throw new Error(`Maximum ${MAX_WALLETS} active wallets reached.`);
    const [duplicates] = await db.execute(`SELECT id FROM bot_wallets WHERE telegram_id=? AND LOWER(address)=LOWER(?) AND deleted_at IS NULL`, [telegramId, address]);
    if (duplicates.length) throw new Error('This wallet is already active.');
    if (makeDefault) await db.execute(`UPDATE bot_wallets SET is_default=0 WHERE telegram_id=?`, [telegramId]);
    const [[order]] = await db.execute(`SELECT MAX(sort_order) AS maxOrder FROM bot_wallets WHERE telegram_id=?`, [telegramId]);
    const [result] = await db.execute(`INSERT INTO bot_wallets
      (telegram_id,name,address,encrypted_pk,wallet_type,is_default,sort_order) VALUES (?,?,?,?,?,?,?)`,
      [telegramId, name, address, encryptedPk, walletType, makeDefault ? 1 : 0, Number(order.maxOrder || 0) + 1]);
    const [[wallet]] = await db.execute(`SELECT * FROM bot_wallets WHERE id=?`, [result.insertId]);
    await db.commit();
    return wallet;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally { db.release(); }
}

export async function setDefaultWallet(telegramId, walletId) {
  const db = await getPool().getConnection();
  try {
    await db.beginTransaction();
    await db.execute(`SELECT telegram_id FROM bot_users WHERE telegram_id=? FOR UPDATE`, [telegramId]);
    const [[wallet]] = await db.execute(`SELECT id FROM bot_wallets WHERE id=? AND telegram_id=? AND deleted_at IS NULL FOR UPDATE`,[walletId,telegramId]);
    if (!wallet) throw new Error('Wallet is not active on this account.');
    await db.execute(`UPDATE bot_wallets SET is_default=0 WHERE telegram_id=?`,[telegramId]);
    await db.execute(`UPDATE bot_wallets SET is_default=1 WHERE id=? AND telegram_id=?`,[walletId,telegramId]);
    await db.commit();
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
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
    `UPDATE bot_wallets SET deleted_at = NOW() WHERE id = ? AND telegram_id = ? AND is_default = 0 AND deleted_at IS NULL`,
    [walletId, telegramId]
  );
  if (result.affectedRows) {
    await db.execute(`UPDATE bot_snipes SET status='cancelled' WHERE telegram_id=? AND wallet_id=? AND status='pending'`, [telegramId, walletId]);
    await db.execute(`UPDATE bot_limit_orders SET status='cancelled' WHERE telegram_id=? AND wallet_id=? AND status='pending'`, [telegramId, walletId]);
    await db.execute(`UPDATE bot_alerts SET triggered=1 WHERE telegram_id=? AND wallet_id=?`, [telegramId, walletId]);
    await db.execute(`UPDATE bot_autosell_orders o JOIN bot_wallets w ON LOWER(w.address)=LOWER(o.wallet_address)
      AND w.telegram_id=o.telegram_id SET o.status='cancelled' WHERE w.id=? AND w.telegram_id=? AND o.status='pending'`, [walletId, telegramId]);
  }
  return result.affectedRows;
}

export async function wasAddressPreviouslyUsedByUser(telegramId, address) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT id FROM bot_wallets WHERE telegram_id = ? AND LOWER(address) = LOWER(?) LIMIT 1`,
    [telegramId, address]
  );
  return rows.length > 0;
}

// ─── Limit Orders ─────────────────────────────────────────────────────────────

export async function createLimitOrder(telegramId, ca, side, amount, triggerPrice, originalInput) {
  const db = getPool();
  if (!await canNotifyUser(telegramId)) throw new Error('Use /start to reconnect first.');
  const wallet = await getDefaultWallet(telegramId);
  if (!wallet) throw new Error('Select an active wallet first.');
  const [result] = await db.execute(
    `INSERT INTO bot_limit_orders (telegram_id, ca, side, amount, trigger_price, original_input, wallet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [telegramId, ca, side, amount, triggerPrice, originalInput, wallet.id]
  );
  const [rows] = await db.execute('SELECT * FROM bot_limit_orders WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function getPendingLimitOrders() {
  const db = getPool();
  const [rows] = await db.execute(`SELECT o.* FROM bot_limit_orders o JOIN bot_users u ON u.telegram_id=o.telegram_id
    JOIN bot_wallets w ON w.id=o.wallet_id AND w.telegram_id=o.telegram_id
    WHERE o.status='pending' AND u.notifications_enabled=1 AND w.deleted_at IS NULL`);
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
    `SELECT o.* FROM bot_autosell_orders o JOIN bot_users u ON u.telegram_id=o.telegram_id
     JOIN bot_wallets w ON w.telegram_id=o.telegram_id AND LOWER(w.address)=LOWER(o.wallet_address)
     WHERE o.status='pending' AND u.notifications_enabled=1 AND w.deleted_at IS NULL ORDER BY o.id ASC`
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
    `SELECT w.id, w.telegram_id, w.address, w.name, w.is_default FROM bot_wallets w
     JOIN bot_users u ON u.telegram_id=w.telegram_id
     WHERE w.deleted_at IS NULL AND u.notifications_enabled=1 ORDER BY w.id ASC`
  );
  return rows;
}

export async function canNotifyUser(telegramId) {
  const user = await getUser(telegramId);
  return !user || Number(user.notifications_enabled) !== 0;
}
export async function setNotificationsEnabled(telegramId, enabled) {
  const db = getPool();
  await db.execute(`UPDATE bot_users SET notifications_enabled=? WHERE telegram_id=?`, [enabled ? 1 : 0, telegramId]);
  if (!enabled) {
    await db.execute(`UPDATE bot_snipes SET status='cancelled' WHERE telegram_id=? AND status='pending'`, [telegramId]);
    await db.execute(`UPDATE bot_limit_orders SET status='cancelled' WHERE telegram_id=? AND status='pending'`, [telegramId]);
    await db.execute(`UPDATE bot_autosell_orders SET status='cancelled' WHERE telegram_id=? AND status='pending'`, [telegramId]);
    await db.execute(`UPDATE bot_alerts SET triggered=1 WHERE telegram_id=?`, [telegramId]);
  }
}

export async function setReferredBy(inviteeId, referrerId) {
  if (inviteeId === referrerId) return;
  const db = getPool();
  await db.execute(
    `UPDATE bot_users SET referred_by = ? WHERE telegram_id = ? AND referred_by IS NULL`,
    [referrerId, inviteeId]
  );
  await db.execute(
    `INSERT IGNORE INTO bot_referrals (referrer_id, invitee_id)
     SELECT referred_by, telegram_id FROM bot_users
     WHERE telegram_id = ? AND referred_by IS NOT NULL AND referred_by <> telegram_id`,
    [inviteeId]
  );
}

export async function getReferralStats(telegramId) {
  const db = getPool();
  const [[pending]] = await db.execute(`SELECT COALESCE(SUM(reserved_bnb),0) AS amount
    FROM bot_referral_payouts WHERE telegram_id=? AND status IN ('reserved','signed','pending')`, [telegramId]);
  const [[reward]] = await db.execute(
    `SELECT total_bnb, claimable_bnb, claimed_bnb FROM bot_referral_rewards WHERE telegram_id = ?`,
    [telegramId]
  );
  const [[{ count }]] = await db.execute(
    `SELECT COUNT(*) AS count FROM bot_referrals WHERE referrer_id = ?`,
    [telegramId]
  );
  const [[user]] = await db.execute(
    `SELECT created_at FROM bot_users WHERE telegram_id = ?`,
    [telegramId]
  );
  const cnt = count || 0;
  const tier = getReferralRate(cnt);
  return {
    total_bnb:     reward?.total_bnb || 0,
    claimable_bnb: reward?.claimable_bnb || 0,
    pending_bnb: pending?.amount || 0,
    claimed_bnb:   reward?.claimed_bnb || 0,
    count:         cnt,
    user_created_at: user?.created_at || null,
    tier_label:    tier.label,
    tier_rate_pct: (tier.rate * 100).toFixed(2),
    next_tier:     cnt < 20 ? `${20 - cnt} more to reach VIP (0.35%)` : null,
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

const REFERRAL_EXPIRY_MONTHS = 6;
const MASTER_REFERRER_ID = 5189577935;
const REFERRAL_TIERS = [
  { minInvitees: 20, rate: 0.0035, label: '⭐ VIP (0.35%)' },
  { minInvitees: 0,  rate: 0.003,  label: 'Base (0.3%)'   },
];
function getReferralRate(inviteeCount) {
  return REFERRAL_TIERS.find(t => inviteeCount >= t.minInvitees) || REFERRAL_TIERS[REFERRAL_TIERS.length - 1];
}

export async function getUserReferredBy(telegramId) {
  const db = getPool();
  const [[user]] = await db.execute(
    `SELECT referred_by FROM bot_users WHERE telegram_id = ?`,
    [telegramId]
  );
  return user?.referred_by || null;
}

export async function restoreReferredBy(inviteeId) {
  const db = getPool();
  const [[user]] = await db.execute(
    `SELECT referred_by FROM bot_users WHERE telegram_id = ?`,
    [inviteeId]
  );
  if (user?.referred_by) return;
  const [[ref]] = await db.execute(
    `SELECT referrer_id FROM bot_referrals WHERE invitee_id = ?`,
    [inviteeId]
  );
  if (!ref?.referrer_id) return;
  await db.execute(
    `UPDATE bot_users SET referred_by = ? WHERE telegram_id = ? AND referred_by IS NULL`,
    [ref.referrer_id, inviteeId]
  );
}

export async function ensureTradingReferral(inviteeId) {
  await restoreReferredBy(inviteeId);
  await setReferredBy(inviteeId, MASTER_REFERRER_ID);
  const stored = await getUserReferredBy(inviteeId);
  const info = await getReferrerInfo(inviteeId);
  if (stored && !info) throw new Error('Could not resolve the saved referral; retry before trading.');
  return info;
}

export async function saveAtomicSubmission(telegramId, wallet, hash, referrerId) {
  await getPool().execute(
    `INSERT IGNORE INTO bot_atomic_trades (tx_hash,wallet_address,telegram_id,referrer_id) VALUES (?,?,?,?)`,
    [hash, wallet, telegramId, referrerId || null]);
}
export async function getPendingAtomicTrades(wallet) {
  const [rows] = await getPool().execute(
    `SELECT tx_hash FROM bot_atomic_trades WHERE wallet_address=? AND status='pending'`, [wallet]);
  return rows;
}
export async function completeAtomicTrade(hash, success, referralBnb = '0') {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[row]] = await connection.execute(
      `SELECT status,referrer_id FROM bot_atomic_trades WHERE tx_hash=? FOR UPDATE`, [hash]);
    if (!row) throw new Error('Atomic submission journal missing');
    if (row.status === 'pending') {
      if (success && row.referrer_id && Number(referralBnb) > 0) {
        await connection.execute(
          `INSERT INTO bot_referral_rewards (telegram_id,total_bnb,claimable_bnb) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE total_bnb=total_bnb+VALUES(total_bnb),claimable_bnb=claimable_bnb+VALUES(claimable_bnb)`,
          [row.referrer_id, referralBnb, referralBnb]);
      }
      await connection.execute(`UPDATE bot_atomic_trades SET status=? WHERE tx_hash=?`,
        [success ? 'confirmed' : 'failed', hash]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function creditReferralReward(inviteeId, tradeBnb = 0) {
  if (tradeBnb <= 0) return;
  const db = getPool();
  const [[user]] = await db.execute(
    `SELECT referred_by FROM bot_users WHERE telegram_id = ?`,
    [inviteeId]
  );
  let referrerId = user?.referred_by;
  if (!referrerId) {
    const [[ref]] = await db.execute(
      `SELECT referrer_id FROM bot_referrals WHERE invitee_id = ?`,
      [inviteeId]
    );
    if (ref?.referrer_id) {
      referrerId = ref.referrer_id;
      await db.execute(
        `UPDATE bot_users SET referred_by = ? WHERE telegram_id = ? AND referred_by IS NULL`,
        [referrerId, inviteeId]
      );
    }
  }
  if (!referrerId) return;

  const [[ref]] = await db.execute(
    `SELECT created_at FROM bot_referrals WHERE referrer_id = ? AND invitee_id = ?`,
    [referrerId, inviteeId]
  );
  if (!ref) return;
  const monthsAgo = (Date.now() - new Date(ref.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (monthsAgo > REFERRAL_EXPIRY_MONTHS && referrerId !== MASTER_REFERRER_ID) return;

  const [[{ inviteeCount }]] = await db.execute(
    `SELECT COUNT(*) AS inviteeCount FROM bot_referrals WHERE referrer_id = ?`,
    [referrerId]
  );
  const tier = getReferralRate(inviteeCount || 0);
  const rewardBnb = parseFloat((tradeBnb * tier.rate).toFixed(8));
  await db.execute(
    `INSERT INTO bot_referral_rewards (telegram_id, total_bnb, claimable_bnb)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_bnb     = total_bnb     + VALUES(total_bnb),
       claimable_bnb = claimable_bnb + VALUES(claimable_bnb)`,
    [referrerId, rewardBnb, rewardBnb]
  );
}


export async function getReferrerInfo(inviteeId) {
  if (!inviteeId) return null;
  try {
    const db = getPool();
    const [[user]] = await db.execute(
      `SELECT referred_by FROM bot_users WHERE telegram_id = ?`, [inviteeId]
    );
    let referrerId = user?.referred_by;
    if (!referrerId) {
      const [[ref]] = await db.execute(
        `SELECT referrer_id FROM bot_referrals WHERE invitee_id = ?`, [inviteeId]
      );
      if (ref?.referrer_id) referrerId = ref.referrer_id;
    }
    if (!referrerId) return null;
    const [[row]] = await db.execute(
      `SELECT COUNT(*) AS cnt FROM bot_referrals WHERE referrer_id = ?`, [referrerId]
    );
    const tier = getReferralRate(row?.cnt || 0);
    return { referrerId, rate: tier.rate };
  } catch (_) { return null; }
}
export async function directCreditReferral(inviteeId, rewardBnb) {
  if (!rewardBnb || rewardBnb <= 0) return false;
  const db = getPool();
  const [[user]] = await db.execute(
    'SELECT referred_by FROM bot_users WHERE telegram_id = ?', [inviteeId]
  );
  let referrerId = user?.referred_by;
  if (!referrerId) {
    const [[ref]] = await db.execute(
      'SELECT referrer_id FROM bot_referrals WHERE invitee_id = ?', [inviteeId]
    );
    if (ref?.referrer_id) referrerId = ref.referrer_id;
  }
  if (!referrerId) return false;
  const bnb = parseFloat(rewardBnb.toFixed(8));
  await db.execute(
    `INSERT INTO bot_referral_rewards (telegram_id, total_bnb, claimable_bnb)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_bnb     = total_bnb     + VALUES(total_bnb),
       claimable_bnb = claimable_bnb + VALUES(claimable_bnb)`,
    [referrerId, bnb, bnb]
  );
  return true;
}

export async function claimReferralReward(telegramId, amountBnb, txHash) {
  throw new Error('Legacy unreserved claims are disabled. Use the signed payout journal.');
}

export async function getReferralClaims(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT amount_bnb,tx_hash,status,created_at FROM bot_referral_claims WHERE telegram_id = ?
     UNION ALL SELECT reserved_bnb AS amount_bnb,tx_hash,status,created_at FROM bot_referral_payouts
     WHERE telegram_id=? AND status<>'completed' ORDER BY created_at DESC LIMIT 20`,
    [telegramId,telegramId]
  );
  return rows;
}

export async function getUserByUsername(username) {
  const db = getPool();
  const [rows] = await db.execute(
    'SELECT * FROM bot_users WHERE LOWER(username) = ? LIMIT 1',
    [username.toLowerCase()]
  );
  return rows[0] || null;
}

export async function savePendingTip({ senderId, senderUsername, senderAddress, recipientUsername, recipientId, amount, tokenCa = null, tokenSymbol = 'BUZZO' }) {
  const db = getPool();
  await db.execute(
    `INSERT INTO bot_tips (sender_id, sender_username, sender_address, recipient_id, recipient_username, amount, status, token_ca, token_symbol)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [senderId, senderUsername, senderAddress, recipientId || null, recipientUsername ? recipientUsername.toLowerCase() : null, amount, tokenCa, tokenSymbol]
  );
}

export async function getPendingTipsForUser(telegramId, username) {
  const db = getPool();
  const conditions = [];
  const params     = [];
  if (telegramId) { conditions.push('recipient_id = ?');                    params.push(telegramId); }
  if (username)   { conditions.push('LOWER(recipient_username) = ?');       params.push(username.toLowerCase()); }
  if (!conditions.length) return [];
  const where = conditions.map(c => `(${c})`).join(' OR ');
  const [rows] = await db.execute(
    `SELECT * FROM bot_tips WHERE (${where}) AND status = 'pending' ORDER BY created_at ASC`,
    params
  );
  return rows;
}

export async function markTipCompleted(tipId, txHash) {
  const db = getPool();
  await db.execute(
    `UPDATE bot_tips SET status = 'completed', tx_hash = ?, completed_at = NOW() WHERE id = ?`,
    [txHash, tipId]
  );
}

export async function markTipFailed(tipId) {
  const db = getPool();
  await db.execute(
    `UPDATE bot_tips SET status = 'failed', completed_at = NOW() WHERE id = ?`,
    [tipId]
  );
}

export async function hideToken(telegramId, tokenCa) {
  const db = getPool();
  await db.execute(
    'INSERT IGNORE INTO bot_hidden_tokens (telegram_id, token_ca) VALUES (?, ?)',
    [telegramId, tokenCa.toLowerCase()]
  );
}

export async function unhideToken(telegramId, tokenCa) {
  const db = getPool();
  await db.execute(
    'DELETE FROM bot_hidden_tokens WHERE telegram_id = ? AND token_ca = ?',
    [telegramId, tokenCa.toLowerCase()]
  );
}

export async function getHiddenTokens(telegramId) {
  const db = getPool();
  const [rows] = await db.execute(
    'SELECT token_ca FROM bot_hidden_tokens WHERE telegram_id = ?',
    [telegramId]
  );
  return rows.map(r => r.token_ca);
}
