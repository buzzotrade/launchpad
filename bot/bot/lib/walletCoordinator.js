// One address queue for all bot-owned spending paths. No private keys are kept here.
export function createWalletCoordinator() {
  const queues = new Map();
  return async function walletQueue(address, operation) {
    if (!/^0x[0-9a-f]{40}$/i.test(address)) throw Error('Invalid wallet address.');
    const key = address.toLowerCase();
    const previous = queues.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(operation);
    queues.set(key, work);
    try { return await work; }
    finally { if (queues.get(key) === work) queues.delete(key); }
  };
}

export const walletQueue = createWalletCoordinator();

// Imports run only once the queued operation starts, avoiding initialization cycles.
// Both trading engines and transfers must check the same durable journals.
export async function withWalletSpend(signer, operation) {
  return walletQueue(signer.address, async () => {
    const { checkPendingWalletTransactions } = await import('./walletTrading.js');
    await checkPendingWalletTransactions(signer);
    return operation();
  });
}

export function walletTransactionError(error) {
  if (/^0x[0-9a-f]{64}$/i.test(error.txHash || '')) {
    return (error.transferPending || error.tradePending
      ? '⏳ Transaction awaiting confirmation/reconciliation. Do not repeat it.'
      : '❌ Transaction reverted. Check the receipt before retrying.') +
      `\nhttps://bscscan.com/tx/${error.txHash}`;
  }
  return '❌ Transfer was not completed. Check the amount, balance and wallet settings.';
}
