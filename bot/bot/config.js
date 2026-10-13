import { getAddress } from 'ethers';

export const BOT_USERNAME = process.env.BUZZO_BOT_USERNAME || 'Buzzotrade_bot';
export const MAX_WALLETS = 11;
export const SITE_URL = 'https://buzzo.trade';
export const FEE_RECEIVER = getAddress('0xa78eccc19fde32710a54cb88db63a19ad8e02934');

export function validateConfig(env = process.env) {
  const missing = ['BUZZO_BOT_TOKEN', 'BUZZO_BOT_DATABASE_URL', 'BUZZO_BOT_MASTER_PRIVATE_KEY', 'BUZZO_BOT_ENCRYPT_SECRET']
    .filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  const database = new URL(env.BUZZO_BOT_DATABASE_URL);
  if (database.protocol !== 'mysql:' || database.pathname !== '/buzzo_bot')
    throw new Error('Buzzo bot must use its dedicated MySQL buzzo_bot database.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.BUZZO_BOT_MASTER_PRIVATE_KEY))
    throw new Error('The Buzzo-only master key is invalid.');
  if (env.BUZZO_BOT_ENCRYPT_SECRET.length < 32)
    throw new Error('The Buzzo-only wallet encryption secret must contain at least 32 characters.');
  if (env.BUZZO_BOT_FEE_WALLET &&
      getAddress(env.BUZZO_BOT_FEE_WALLET.toLowerCase()) !== FEE_RECEIVER)
    throw new Error('The fee receiver does not match the approved Buzzo receiver.');
  return { feeReceiver: FEE_RECEIVER, username: BOT_USERNAME };
}
