export function parseSwapError(err) {
  const msg = (err?.message || String(err) || '').toLowerCase();
  if (msg.includes('wallet swap reverted')) return {
    reason: 'The swap reverted. No trading fee was accrued; network gas still applies.',
    suggestion: 'Check the transaction and token restrictions before submitting another trade.',
  };

  if (msg.includes('complete trade batch could not be simulated')) {
    return {
      reason: 'The full trade could not pass simulation. No transaction or trading fee was sent.',
      suggestion: 'Check wallet compatibility, token restrictions and available liquidity before trying again.',
    };
  }
  if (msg.includes('approved network gas budget')) {
    return {
      reason: 'The trade exceeds the approved network gas budget. Nothing was sent.',
      suggestion: 'Review the estimated network cost before approving a different budget.',
    };
  }

  if (msg.includes('insufficient_output_amount') || msg.includes('insufficient output amount')) {
    return {
      reason: 'Slippage too low — the price moved before the trade completed',
      suggestion: 'Increase slippage to 15–25% in ⚙️ Settings and try again.',
    };
  }
  if (msg.includes('transfer_from_failed') || msg.includes('transferfrom') || msg.includes('transfer failed')) {
    return {
      reason: 'Token transfer rejected — possible honeypot or approval issue',
      suggestion: 'Scan the token first with 🔍 Scan Token. It may have trading restrictions.',
    };
  }
  if (msg.includes('insufficient funds') || msg.includes('insufficient balance')) {
    return {
      reason: 'Insufficient BNB to cover the swap and gas',
      suggestion: 'Deposit more BNB to your wallet via 📥 Receive.',
    };
  }
  if (msg.includes('gas required exceeds allowance') || msg.includes('gas limit')) {
    return {
      reason: 'Gas limit exceeded',
      suggestion: 'Try a higher gas setting (Fast or Turbo) in ⚙️ Settings.',
    };
  }
  if (msg.includes('expired') || msg.includes('deadline')) {
    return {
      reason: 'Transaction expired — network was too slow',
      suggestion: 'Switch to a faster gas mode (Turbo) in ⚙️ Settings and retry.',
    };
  }
  if (msg.includes('nonce')) {
    return {
      reason: 'Transaction nonce conflict',
      suggestion: 'Wait a moment and try again.',
    };
  }
  if (msg.includes('replacement fee too low') || msg.includes('underpriced') || msg.includes('fee too low')) {
    return {
      reason: 'Gas price too low for current network conditions',
      suggestion: 'Increase gas to Fast or Turbo in ⚙️ Settings.',
    };
  }
  if (msg.includes('insufficient_a_amount') || msg.includes('insufficient_b_amount') || msg.includes('insufficient liquidity')) {
    return {
      reason: 'Insufficient liquidity on this trading pair',
      suggestion: 'Try a smaller amount, or wait for more liquidity.',
    };
  }
  if (msg.includes('FLAP_INDUEL')) {
    return {
      reason: 'Token is locked in a Flap Duel',
      suggestion: 'Selling is temporarily disabled by the Flap protocol while this token is dueling. Wait for the duel to end and try again.',
    };
  }
  if (msg.includes('FLAP_KILLED')) {
    return {
      reason: 'Token was eliminated in a Flap Duel',
      suggestion: 'This token lost its Flap Duel and trading has been permanently disabled by the protocol.',
    };
  }
  if (msg.includes('execution reverted')) {
    return {
      reason: 'Transaction rejected by the token contract',
      suggestion: 'The token may have high tax, trading restrictions, or be a honeypot. Use 🔍 Scan Token to verify.',
    };
  }
  if (msg.includes('blacklist') || msg.includes('not allowed') || msg.includes('forbidden')) {
    return {
      reason: 'Your wallet is blacklisted by this token',
      suggestion: 'This token has blocked your wallet address from trading.',
    };
  }
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnrefused') || msg.includes('network')) {
    return {
      reason: 'Network connection issue',
      suggestion: 'The RPC may be temporarily unavailable. Try again in a moment.',
    };
  }

  return {
    reason: 'Unexpected error during transaction',
    suggestion: 'Try again. If it persists, check your slippage/gas settings or use 🔍 Scan Token.',
  };
}

export function buyFailMsg(ca, err) {
  return tradeFailMsg('Buy', ca, err);
}

export function sellFailMsg(ca, err) {
  return tradeFailMsg('Sell', ca, err);
}

export function snipeFailMsg(ca, err) {
  return tradeFailMsg('Buy', ca, err);
}

export function limitFailMsg(orderId, ca, err) {
  return tradeFailMsg('Trade', ca, err);
}

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function tradeFailMsg(side, ca, error) {
  const pending = error?.tradePending === true;
  const reason = pending ? 'Check the transaction before placing this trade again.'
    : error?.txHash ? 'Transaction reverted.' : parseSwapError(error).reason;
  return `${pending ? '⏳' : '❌'} <b>${side} ${pending ? 'pending' : 'failed'}</b>\n\n` +
    `${esc(reason)}\n` +
    (error?.txHash ? `<a href="https://bscscan.com/tx/${error.txHash}">View transaction</a>`
      : `<a href="https://bscscan.com/token/${ca}">View token</a>`);
}
const quantity = value => value == null || !Number.isFinite(Number(value)) ? 'Unavailable'
  : Number(value).toLocaleString('en', { maximumFractionDigits: 8 });

export function buySuccessMsg(ca, bnbSpent, txHash, router, tokensReceived, tokenSymbol, feeBnb = 0, tokenPriceUsd = 0, walletName = null, result = {}) {
  const symbolTag = tokenSymbol || ca.slice(-6);
  return (
    `✅ <b>Buy successful</b>${walletName ? ` · ${esc(walletName)}` : ''}\n\n` +
    `Amount: <b>${quantity(result.grossBnb ?? bnbSpent)} BNB</b>\n` +
    `Quoted: <b>${quantity(result.quotedTokens)} ${esc(symbolTag)}</b>\n` +
    `Received: <b>${quantity(tokensReceived)} ${esc(symbolTag)}</b>\n` +
    `<a href="https://bscscan.com/tx/${txHash}">Tx</a> | ` +
    `<a href="https://dexscreener.com/bsc/${ca}">Chart (Dexscreener)</a>`
  );
}

export function sellSuccessMsg(ca, symbol, percent, receivedBnb, txHash, router, feeBnb = 0, bnbPriceUsd = 0, walletName = null, result = {}) {
  return (
    `✅ <b>Sell successful</b>${walletName ? ` · ${esc(walletName)}` : ''}\n\n` +
    `Sold: <b>${result.tokensSold == null ? `${quantity(percent)}%` : quantity(result.tokensSold)} ${esc(symbol || result.tokenSymbol || 'tokens')}</b>\n` +
    `Quoted: <b>${quantity(result.quotedBnb)} BNB</b>\n` +
    `Received: <b>${quantity(receivedBnb)} BNB</b>\n` +
    `<a href="https://bscscan.com/tx/${txHash}">Tx</a> | ` +
    `<a href="https://dexscreener.com/bsc/${ca}">Chart (Dexscreener)</a>`
  );
}

export function snipeSuccessMsg(ca, bnbSpent, txHash, router, result = {}) {
  return buySuccessMsg(ca, bnbSpent, txHash, router, result.tokensReceived, result.tokenSymbol, 0, 0, null, result);
}

export function limitSuccessMsg(orderId, side, ca, price, amount, txHash, router, result = {}) {
  return side === 'buy'
    ? buySuccessMsg(ca, result.swapBnb ?? amount, txHash, router, result.tokensReceived, result.tokenSymbol, 0, 0, null, result)
    : sellSuccessMsg(ca, result.tokenSymbol, result.percentSold ?? amount, result.receivedBnb, txHash, router, 0, 0, null, result);
}
