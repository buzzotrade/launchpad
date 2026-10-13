import { ethers } from 'ethers';
import { encryptKey, decryptKey, getProvider } from './walletLib.js';
import { getReferralStats } from './db.js';
import { getActivePayout, outstandingReferralBnb, reserveReferralPayout, saveSignedPayout,
  markPayoutPending, finishReferralPayout } from './referralClaimsDb.js';
import { walletQueue } from './walletCoordinator.js';
const same = (a,b) => a?.toLowerCase() === b?.toLowerCase();
const inFlight = new Map();
export function payoutMath(reservedBnb, gasLimit, gasPrice) {
  if (gasLimit <= 0n || gasPrice <= 0n) throw new Error('Invalid payout gas estimate');
  const reserved = ethers.parseEther(String(reservedBnb));
  const netWei = reserved - gasLimit * gasPrice;
  if (netWei <= 0n) throw new Error('Reward is smaller than its network gas');
  return { reserved, netWei };
}
export function refundForReceipt(reservedBnb, netWei, receipt) {
  const leftover = ethers.parseEther(String(reservedBnb)) - BigInt(netWei) - receipt.gasUsed * receipt.gasPrice;
  if (leftover < 0n) throw new Error('Payout exceeded reserved funds');
  // Reward balances use 8 decimal places. Retain only sub-ledger-precision dust.
  return ethers.formatEther(leftover / 10000000000n * 10000000000n);
}
export function referralTreasury(provider = getProvider()) {
  // One configured treasury; never switch to a second wallet when funding is low.
  const key = process.env.BUZZO_BOT_FEE_PRIVATE_KEY || process.env.BUZZO_BOT_MASTER_PRIVATE_KEY;
  if (!key) throw new Error('Payout treasury not configured');
  return new ethers.Wallet(key, provider);
}
async function settle(row, receipt, provider) {
  if (![0,1].includes(receipt.status)) throw new Error('Unknown payout receipt status');
  const tx = await provider.getTransaction(row.tx_hash);
  if (!tx || !same(tx.from,row.treasury) || !same(tx.to,row.recipient) ||
      tx.value !== BigInt(row.net_wei) || tx.nonce !== Number(row.nonce) || tx.chainId !== 56n)
    throw new Error('Payout receipt failed journal validation');
  if (receipt.status === 0) {
    await finishReferralPayout(row.id,false);
    return { kind:'failed', hash:row.tx_hash };
  }
  const refund = refundForReceipt(row.reserved_bnb,row.net_wei,receipt);
  await finishReferralPayout(row.id,true,refund);
  return { kind:'completed', hash:row.tx_hash, receivedBnb:ethers.formatEther(row.net_wei), refundBnb:refund };
}
async function submitAndReconcile(row, provider, wait) {
  let receipt = await provider.getTransactionReceipt(row.tx_hash);
  if (receipt) return settle(row,receipt,provider);
  const raw = decryptKey(row.encrypted_raw);
  const tx = ethers.Transaction.from(raw);
  if (!same(tx.hash,row.tx_hash) || !same(tx.from,row.treasury) || !same(tx.to,row.recipient) ||
      tx.value !== BigInt(row.net_wei) || tx.chainId !== 56n || tx.nonce !== Number(row.nonce))
    throw new Error('Encrypted payout does not match its journal');
  try {
    await provider.broadcastTransaction(raw);
    await markPayoutPending(row.id);
  } catch { /* Unknown submission stays reserved. Retry only the IDENTICAL signed bytes. */ }
  try {
    receipt = wait ? await provider.waitForTransaction(row.tx_hash,1,45000) : await provider.getTransactionReceipt(row.tx_hash);
  } catch { return { kind:'pending',hash:row.tx_hash }; }
  return receipt ? settle(row,receipt,provider) : { kind:'pending',hash:row.tx_hash };
}
async function processClaim(userId, recipient, wait, treasury) {
  const provider = treasury.provider;
  if (BigInt(await provider.send('eth_chainId',[])) !== 56n) throw new Error('BSC mainnet required');
  let active = await getActivePayout();
  if (active) {
    if (active.tx_hash) {
      const result = await submitAndReconcile(active,provider,wait);
      if (Number(active.telegram_id) === userId) return result;
      if (result.kind === 'pending') return { kind:'busy' };
      active = null;
    } else return { kind:'busy' };
  }
  const { checkPendingWalletTransactions } = await import('./walletTrading.js');
  await checkPendingWalletTransactions(treasury, { ignoreReferral: true });
  const stats = await getReferralStats(userId);
  if (Number(stats.claimable_bnb) <= 0) return { kind:'empty' };
  const liabilities = ethers.parseEther(await outstandingReferralBnb());
  if (await provider.getBalance(treasury.address) < liabilities) return { kind:'unfunded' };
  const { active: row, created } = await reserveReferralPayout(userId,recipient,treasury.address);
  if (!row) return { kind:'empty' };
  if (!created) return { kind:'busy' };
  try {
    const pending = Number(BigInt(await provider.send('eth_getTransactionCount',[treasury.address,'pending'])));
    const latest = Number(BigInt(await provider.send('eth_getTransactionCount',[treasury.address,'latest'])));
    if (pending !== latest) throw new Error('Treasury already has an unresolved transaction');
    const gasPrice = (await provider.getFeeData()).gasPrice;
    const estimate = await treasury.estimateGas({ to:recipient,value:1n });
    const gasLimit = estimate * 125n / 100n;
    if (gasLimit > 200000n) throw new Error('Recipient gas exceeds payout limit');
    const { netWei } = payoutMath(row.reserved_bnb,gasLimit,gasPrice);
    const raw = await treasury.signTransaction({ to:recipient,value:netWei,nonce:pending,
      gasLimit,gasPrice,chainId:56,type:0 });
    const data = { hash:ethers.keccak256(raw), encryptedRaw:encryptKey(raw),netWei,gasPrice,gasLimit,nonce:pending };
    await saveSignedPayout(row.id,data);
    Object.assign(row,{ tx_hash:data.hash,encrypted_raw:data.encryptedRaw,net_wei:String(netWei),nonce:pending,status:'signed' });
  } catch {
    // Only unsigned reservations may be released. Signed/unknown transactions remain locked.
    const current = await getActivePayout();
    if (current?.id === row.id && current.tx_hash) return { kind:'pending',hash:current.tx_hash };
    if (current?.id === row.id && current.status === 'reserved') await finishReferralPayout(row.id,false,'0',true);
    return { kind:'blocked' };
  }
  return submitAndReconcile(row,provider,wait);
}
export async function claimReferralSafely(userId, recipient, { wait = true } = {}) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !ethers.isAddress(recipient) || same(recipient,ethers.ZeroAddress))
    throw new Error('Invalid claim identity or destination');
  // Repeat clicks join the same promise; the SQL lease also protects other processes/users.
  if (inFlight.has(userId)) return inFlight.get(userId);
  const treasury = referralTreasury();
  const work = walletQueue(treasury.address, () => processClaim(userId,recipient,wait,treasury));
  inFlight.set(userId,work);
  try { return await work; } finally { if (inFlight.get(userId) === work) inFlight.delete(userId); }
}
export async function reconcileReferralPayout() {
  const active = await getActivePayout();
  if (!active) return null;
  return walletQueue(active.treasury, async () => {
    // Re-read after acquiring the address queue: another claim may have settled it.
    const current = await getActivePayout();
    if (!current || Number(current.id) !== Number(active.id)) return null;
    if (current.tx_hash) return submitAndReconcile(current,getProvider(),false);
    if (current.status === 'reserved' && Date.now() - new Date(current.updated_at).getTime() > 600000)
      await finishReferralPayout(current.id,false,'0',true);
    return null;
  });
}
export function startReferralPayoutReconciler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await reconcileReferralPayout(); }
    catch { console.error('[Referral] Payout reconciliation deferred; journal retained.'); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick,30000); timer.unref();
  return () => clearInterval(timer);
}
