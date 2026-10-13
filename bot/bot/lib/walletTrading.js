import { ethers } from 'ethers';
import { FEE_RECEIVER } from '../config.js';
import { journal } from './walletTradeJournal.js';
import { decryptKey, getSigner } from './walletLib.js';
import { suppressDepositFor } from '../monitor.js';
import { reconcilePendingAtomicTrades } from './atomicFees.js';
import { withWalletSpend } from './walletCoordinator.js';
export { walletQueue } from './walletCoordinator.js';

let historyRpc;
function getHistoryRpc() {
  if (!historyRpc && process.env.BSC_HISTORY_RPC_URL)
    historyRpc = new ethers.JsonRpcProvider(process.env.BSC_HISTORY_RPC_URL, 56, { staticNetwork: true });
  return historyRpc;
}
const wrap = new ethers.Interface(['event Withdrawal(address indexed src,uint256 wad)']);
const approval = new ethers.Interface(['function approve(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)']);
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const NATIVE_BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const kyberEvents = new ethers.Interface([
  'event Swapped(address sender,address srcToken,address dstToken,address dstReceiver,uint256 spentAmount,uint256 returnAmount)',
]);
export function feesFor(gross, p) {
  gross = BigInt(gross);
  const dollar = BigInt(p.dollarWei), min = (a,b) => a < b ? a : b, max = (a,b) => a > b ? a : b;
  if (gross <= 0n || dollar <= 0n || ![30,35].includes(Number(p.referralBps))) throw Error('Invalid fee policy.');
  if (gross < ethers.parseEther('0.05')) return {
    platform: p.referred ? gross * 70n / 10000n : gross / 100n,
    referral: p.referred ? gross * 30n / 10000n : 0n,
  };
  const cap = gross * 80n / 100n;
  return p.referred ? {
    platform: min(max(gross * 30n / 10000n, dollar) + dollar, cap * 55n / 100n),
    referral: min(max(gross * BigInt(p.referralBps) / 10000n, dollar), cap * 45n / 100n),
  } : { platform: min(max(gross * 35n / 10000n, dollar) + dollar, cap), referral: 0n };
}
export async function saleOutput(provider, receipt, wallet) {
  // Kyber's executor can unwrap WBNB, so its Withdrawal address is not the
  // router. Use only the allowlisted router's successful native-output event
  // for this exact wallet, never an executor log or the quoted amount.
  if (receipt.status === 1 && receipt.to?.toLowerCase() === KYBER_ROUTER) {
    const outputs = (receipt.logs || []).flatMap(log => {
      if (log.address.toLowerCase() !== KYBER_ROUTER) return [];
      try {
        const event = kyberEvents.parseLog(log);
        if (event?.name !== 'Swapped' ||
            event.args.sender.toLowerCase() !== wallet.toLowerCase() ||
            event.args.dstReceiver.toLowerCase() !== wallet.toLowerCase() ||
            event.args.dstToken.toLowerCase() !== NATIVE_BNB ||
            event.args.srcToken.toLowerCase() === NATIVE_BNB ||
            event.args.spentAmount <= 0n || event.args.returnAmount <= 0n) return [];
        return [event.args.returnAmount];
      } catch { return []; }
    });
    if (outputs.length === 1) return outputs[0];
  }
  // A call trace proves actual native transfers to this wallet, excluding unrelated deposits.
  for (const traceProvider of [provider, getHistoryRpc()].filter((p,i,a) => p && a.indexOf(p) === i)) {
    try {
      const tree = await traceProvider.send('debug_traceTransaction', [receipt.hash, { tracer: 'callTracer', timeout: '3s' }]);
      let received = 0n, sent = 0n;
      function walk(call) {
        if (call.error) return;
        const value = BigInt(call.value || '0x0');
        if (call.type === 'CALL') {
          if (call.to?.toLowerCase() === wallet.toLowerCase()) received += value;
          if (call.from?.toLowerCase() === wallet.toLowerCase()) sent += value;
        }
        for (const child of call.calls || []) walk(child);
      }
      walk(tree);
      if (received > sent) return received - sent;
    } catch {}
    }
  // Direct Pancake routes unwrap WBNB exactly once to the signed recipient.
  const direct = ['0x10ed43c718714eb63d5aa57b78b54704e256024e', '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'];
  const logs = receipt.logs.filter(l => l.address.toLowerCase() === WBNB).flatMap(l => {
    try { const e = wrap.parseLog(l); return e?.name === 'Withdrawal' && direct.includes(e.args.src.toLowerCase()) ? [e.args.wad] : []; }
    catch { return []; }
  });
  return logs.length === 1 ? logs[0] : null;
}
async function reconcile(signer, row, receipt) {
  if (receipt.status === 0) { await journal.finish(row, false); return; }
  let fees = null;
  if (row.kind === 'swap') {
    const gross = row.meta.buy ? BigInt(row.meta.gross) : await saleOutput(signer.provider, receipt, signer.address);
    // Unknown receipt output stays pending for reconciliation; never charge a guessed sell fee.
    if (gross === null) {
      const error = Error('Previous sell output needs reconciliation. Check its hash before another wallet transaction.');
      error.txHash = row.tx_hash; error.tradePending = true; throw error;
    }
    fees = feesFor(gross, row.meta.policy);
  }
  await journal.finish(row, true, fees);
}
export async function checkPendingWalletTransactions(signer, { ignoreReferral = false } = {}) {
  if (!ignoreReferral) {
    const { getActivePayout } = await import('./referralClaimsDb.js');
    const payout = await getActivePayout();
    if (payout?.treasury?.toLowerCase() === signer.address.toLowerCase()) {
      const error = Error('A treasury payout is awaiting reconciliation. No other wallet transaction was sent.');
      error.txHash = payout.tx_hash; error.tradePending = true; throw error;
    }
  }
  await reconcilePendingAtomicTrades(signer);
  for (const row of await journal.pending(signer.address)) {
    const receipt = await signer.provider.getTransactionReceipt(row.tx_hash);
    if (receipt) await reconcile(signer, row, receipt);
    else {
      // Recover uncertain submission with the SAME signed bytes, never a second trade.
      const raw = decryptKey(row.encrypted_raw);
      if (ethers.keccak256(raw).toLowerCase() !== row.tx_hash.toLowerCase()) throw Error('Signed journal hash mismatch.');
      try {
        if (row.meta.antiMev) {
          await fetch('https://api.48.club', { method:'POST', headers:{'content-type':'application/json'},
            body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[raw]}),
            signal:AbortSignal.timeout(10000) });
        } else await signer.provider.broadcastTransaction(raw);
      } catch {}
      const error = Error('Previous transaction is pending. Check its hash before repeating.');
      error.txHash = row.tx_hash; error.tradePending = true; throw error;
    }
  }
}
async function send(signer, call, kind, meta, opts) {
  if (!Number.isSafeInteger(opts.telegramId) || opts.telegramId <= 0) throw Error('Valid transaction user required.');
  const p = signer.provider;
  if (BigInt(await p.send('eth_chainId', [])) !== 56n) throw Error('Trading requires BSC mainnet.');
  if (kind !== 'fee' && call.target.toLowerCase() === signer.address.toLowerCase())
    throw Error('Trading must target a router or token, not modify the wallet.');
  const price = opts.gasPrice || (await p.getFeeData()).gasPrice;
  const req = { to: call.target, data: call.data, value: call.value, chainId: 56, type: 0, gasPrice: price,
    nonce: Number(BigInt(await p.send('eth_getTransactionCount', [signer.address, 'pending']))) };
  const gas = await signer.estimateGas(req);
  if (gas <= 0n || gas > 2500000n) throw Error('Trade simulation exceeded the safety limit. Nothing was sent.');
  req.gasLimit = gas * 125n / 100n;
  if (opts.maxGasWei != null && req.gasLimit * price > opts.maxGasWei) throw Error('Trade exceeds approved network gas budget.');
  if (await p.getBalance(signer.address) < call.value + req.gasLimit * price) throw Error('Insufficient BNB for trade and gas.');
  const raw = await signer.signTransaction(req), hash = ethers.keccak256(raw);
  meta = { ...meta, antiMev:!!opts.antiMev };
  const row = { tx_hash: hash, wallet: signer.address, telegram_id: opts.telegramId, kind, meta };
  await journal.save(hash, signer.address, opts.telegramId, kind, meta, raw);
  if (opts.onSigned) await opts.onSigned({ hash, raw });
  suppressDepositFor(signer.address, 150000);
  let receipt;
  try {
    if (opts.antiMev) {
      const r = await fetch('https://api.48.club', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[raw] }),
        signal: AbortSignal.timeout(15000) });
      const result = await r.json();
      if (result.result?.toLowerCase() !== hash.toLowerCase()) throw Error('Private submission uncertain.');
    } else await p.broadcastTransaction(raw);
    receipt = await p.waitForTransaction(hash, 1, 120000);
    if (!receipt) throw Error('Receipt pending.');
    await reconcile(signer, row, receipt);
  } catch {
    const error = Error('Transaction confirmation needs checking. Do not repeat.');
    error.txHash = hash; error.tradePending = receipt?.status !== 0; throw error;
  }
  if (receipt.status === 0) {
    const error = Error('Wallet swap reverted. No trading fee was accrued; network gas still applies.');
    error.txHash = hash; error.tradePending = false; throw error;
  }
  return receipt;
}
export async function executeWalletTrade(signer, calls, policy, opts) {
  if (!Number.isSafeInteger(opts.telegramId) || opts.telegramId <= 0) throw Error('Valid trading user required.');
  if (!calls.length) throw Error('Empty swap request.');
  return withWalletSpend(signer, async () => {
    const meta = { buy: opts.buy, gross: String(opts.gross || 0n),
      policy: { ...policy, dollarWei: String(policy.dollarWei) } };
    for (const call of calls.slice(0,-1)) {
      const decoded = approval.parseTransaction({ data: call.data });
      if (decoded?.name !== 'approve' || call.value !== 0n) throw Error('Unsupported approval call.');
      await send(signer, call, 'approval', {}, opts);
      const allowance = await new ethers.Contract(call.target, approval, signer.provider).allowance(signer.address, decoded.args[0]);
      if ((decoded.args[1] === 0n && allowance !== 0n) || allowance < decoded.args[1]) throw Error('Token approval did not succeed. No swap was sent.');
    }
    const receipt = await send(signer, calls.at(-1), 'swap', meta, opts);
    const gross = opts.buy ? BigInt(opts.gross) : await saleOutput(signer.provider, receipt, signer.address);
    const fees = gross === null ? null : feesFor(gross, policy);
    return { txHash: receipt.hash, receipt, blockNumber: receipt.blockNumber,
      gasSpent: receipt.gasUsed * receipt.gasPrice,
      grossBnb: gross === null ? null : Number(ethers.formatEther(gross)),
      receivedBnb: opts.buy || gross === null ? null : Number(ethers.formatEther(gross)),
      platFee: fees ? Number(ethers.formatEther(fees.platform + fees.referral)) : null,
      platformFee: fees ? Number(ethers.formatEther(fees.platform)) : null,
      referralFee: fees ? Number(ethers.formatEther(fees.referral)) : null };
  });
}
let collecting = false;
export function startWalletFeeCollector() {
  const tick = async () => {
    if (collecting) return;
    collecting = true;
    try {
      for (const wallet of await journal.wallets()) {
        const signer = getSigner(decryptKey(wallet.encrypted_pk));
        await withWalletSpend(signer, async () => {
          const debts = await journal.debts(signer.address, wallet.telegram_id);
          if (!debts.length) return;
          const total = debts.reduce((n,d) => n + BigInt(d.platform_wei) + BigInt(d.referral_wei), 0n);
          const price = (await signer.provider.getFeeData()).gasPrice;
          const gas = await signer.estimateGas({ to:FEE_RECEIVER,value:total });
          // Accumulate small fees, rather than charging gas for every swap.
          if (total < gas * price * 4n || await signer.provider.getBalance(signer.address) < total + gas * price * 125n/100n) return;
          await send(signer, { target:FEE_RECEIVER,value:total,data:'0x' }, 'fee', { debts }, { telegramId:wallet.telegram_id,gasPrice:price });
        }).catch(() => console.warn('[Trading fees] Reconciliation deferred; no duplicate payment attempted.'));
      }
    } catch { console.warn('[Trading fees] Collector deferred.'); }
    finally { collecting = false; }
  };
  const timer = setInterval(() => { void tick(); }, 20000); timer.unref();
}

// Called only from inside the shared address queue by transfer helpers.
export async function sendWalletTransfer(signer, call, telegramId) {
  try {
    return await send(signer, call, 'transfer', {}, { telegramId });
  } catch (error) {
    if (error.txHash) error.transferPending = !!error.tradePending;
    throw error;
  }
}
