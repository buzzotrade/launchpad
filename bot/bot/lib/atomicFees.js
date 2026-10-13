import fs from 'node:fs/promises';
import { ethers } from 'ethers';
import { FEE_RECEIVER } from '../config.js';
import { saveAtomicSubmission, getPendingAtomicTrades, completeAtomicTrade } from './db.js';
import { suppressDepositFor } from '../monitor.js';
import { withWalletSpend } from './walletCoordinator.js';

const artifact = JSON.parse(await fs.readFile(new URL('../../contracts/compiled.json', import.meta.url)));
const deployed = JSON.parse(await fs.readFile(new URL('../../contracts/deployed.json', import.meta.url)));
export const ATOMIC_ACCOUNT = deployed.address;
const iface = new ethers.Interface(artifact.abi);
const checkedProviders = new WeakSet();
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export async function quoteAtomicFees(provider, gross, policy) {
  await checkImplementation(provider);
  const [platformWei, referralWei] = await new ethers.Contract(ATOMIC_ACCOUNT, artifact.abi, provider).quoteFees(gross, policy);
  return { platformWei, referralWei, feeWei: platformWei + referralWei };
}
async function checkImplementation(provider) {
  if (checkedProviders.has(provider)) return;
  if (BigInt(await provider.send('eth_chainId', [])) !== 56n) throw new Error('Atomic trading requires BSC mainnet.');
  const code = await provider.getCode(ATOMIC_ACCOUNT);
  if (ethers.keccak256(code) !== deployed.runtimeHash ||
      !same(await new ethers.Contract(ATOMIC_ACCOUNT, artifact.abi, provider).feeReceiver(), FEE_RECEIVER))
    throw new Error('Atomic fee implementation does not match the audited deployment.');
  checkedProviders.add(provider);
}
function tradeEvent(receipt, wallet) {
  for (const log of receipt.logs) {
    if (!same(log.address, wallet)) continue;
    try { const event = iface.parseLog(log); if (event?.name === 'AtomicTrade') return event.args; }
    catch {}
  }
  throw new Error(`Confirmed transaction has no atomic fee receipt: ${receipt.hash}. Do not repeat.`);
}
async function settleReceipt(receipt, wallet) {
  if (receipt.status === 0) { await completeAtomicTrade(receipt.hash, false); return null; }
  const event = tradeEvent(receipt, wallet);
  try { await completeAtomicTrade(receipt.hash, true, ethers.formatEther(event.referralFee)); }
  catch {
    const error = new Error('Confirmed trade awaits journal reconciliation. Do not repeat it.');
    error.txHash = receipt.hash; error.tradePending = true; throw error;
  }
  return event;
}
export async function reconcilePendingAtomicTrades(signer) {
  for (const row of await getPendingAtomicTrades(signer.address)) {
    const receipt = await signer.provider.getTransactionReceipt(row.tx_hash);
    if (!receipt) {
      const error = new Error('Previous trade is still pending. Do not repeat it.');
      error.txHash = row.tx_hash; error.tradePending = true; throw error;
    }
    await settleReceipt(receipt, signer.address);
  }
}
export async function executeAtomicTrade(signer, calls, policy, { buy, gross = 0n, telegramId, antiMev, gasPrice, maxGasWei, onSigned }) {
  return withWalletSpend(signer, async () => {
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0)
      throw new Error('A valid trading user is required before signing.');
    await checkImplementation(signer.provider);
    const nonce = Number(BigInt(await signer.provider.send('eth_getTransactionCount', [signer.address, 'pending'])));
    const data = iface.encodeFunctionData(buy ? 'buy' : 'sell',
      buy ? [calls, gross, policy] : [calls, policy]);
    const price = gasPrice || (await signer.provider.getFeeData()).gasPrice;
    const request = { to: signer.address, data, value: 0n, nonce, chainId: 56, type: 0, gasPrice: price };
    // Estimate the ENTIRE batch before signing/broadcasting, including approvals and fee.
    let estimate;
    try { estimate = await signer.estimateGas(request); }
    catch { throw new Error('The complete trade batch could not be simulated. No transaction or fee was sent.'); }
    if (estimate <= 0n || estimate > 2500000n) throw new Error('Atomic trade gas estimate exceeds the safety limit.');
    request.gasLimit = estimate * 125n / 100n;
    if (maxGasWei != null && request.gasLimit * price > maxGasWei)
      throw new Error('This transaction would exceed the approved network gas budget. Nothing was sent.');
    const balance = await signer.provider.getBalance(signer.address);
    if (balance < (buy ? gross : 0n) + request.gasLimit * price)
      throw new Error('Not enough BNB for the trade and its network gas. No transaction was sent.');
    const raw = await signer.signTransaction(request);
    const hash = ethers.keccak256(raw);
    // Persist BEFORE broadcast. An uncertain RPC result must never lead to a duplicate trade.
    await saveAtomicSubmission(telegramId, signer.address, hash, policy.referrerId);
    if (onSigned) await onSigned({ hash, raw });
    suppressDepositFor(signer.address, 150000);
    let minedReceipt;
    try {
      if (antiMev) {
        const response = await fetch('https://api.48.club', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
          signal: AbortSignal.timeout(15000) });
        const result = await response.json();
        if (result.error || !same(result.result || '', hash)) throw new Error('Private relay submission uncertain.');
      } else {
        const sent = await signer.provider.broadcastTransaction(raw);
        if (!same(sent.hash, hash)) throw new Error('RPC returned an unexpected transaction hash.');
      }
      const receipt = await signer.provider.waitForTransaction(hash, 1, 120000);
      if (!receipt) throw new Error('Receipt pending.');
      minedReceipt = receipt;
      const event = await settleReceipt(receipt, signer.address);
      if (!event) throw new Error('Atomic swap reverted; no trading fee was collected (network gas still applies).');
      return { txHash: hash, receipt, blockNumber: receipt.blockNumber,
        gasSpent: receipt.gasUsed * receipt.gasPrice,
        grossBnb: Number(ethers.formatEther(event.grossBnb)),
        platFee: Number(ethers.formatEther(event.platformFee + event.referralFee)),
        platformFee: Number(ethers.formatEther(event.platformFee)),
        referralFee: Number(ethers.formatEther(event.referralFee)),
        receivedBnb: Number(ethers.formatEther(event.grossBnb - event.platformFee - event.referralFee)) };
    } catch (error) {
      const pending = new Error(`Trade submission or confirmation needs checking. TX: ${hash}. Check this hash before repeating.`);
      pending.txHash = hash;
      pending.tradePending = !minedReceipt || minedReceipt.status !== 0;
      throw pending;
    }
  });
}
