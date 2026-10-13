import crypto from 'crypto';
import { ethers } from 'ethers';
import { withWalletSpend } from './walletCoordinator.js';

const ALGORITHM = 'aes-256-gcm';

function getEncryptKey() {
  const secret = process.env.BUZZO_BOT_ENCRYPT_SECRET;
  if (!secret) throw new Error('BUZZO_BOT_ENCRYPT_SECRET not set');
  return crypto.scryptSync(secret, 'buzzo-bot-salt-v1', 32);
}

export function encryptKey(privateKey) {
  const key = getEncryptKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptKey(encryptedBase64) {
  const key = getEncryptKey();
  const data = Buffer.from(encryptedBase64, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

export function getMasterWallet() {
  const pk = process.env.BUZZO_BOT_MASTER_PRIVATE_KEY;
  if (!pk) throw new Error('BUZZO_BOT_MASTER_PRIVATE_KEY not set');
  const provider = getProvider();
  return new ethers.Wallet(pk, provider);
}

// ─── Multi-Wallet: Active wallet for a user ──────────────────────────────────

export async function seedHdWalletIfNeeded(telegramId) {
  const { getUserWallets, createWalletRecord } = await import('./db.js');
  const wallets = await getUserWallets(telegramId);
  if (wallets.length === 0) {
    const { address, privateKey } = deriveUserWallet(telegramId);
    const encPk = encryptKey(privateKey);
    try { await createWalletRecord(telegramId, 'Wallet 1', address, encPk, 'hd', true); }
    catch (error) {
      // A concurrent /start or incoming tip may have provisioned the same wallet.
      if (!(await getUserWallets(telegramId)).some(wallet => wallet.address.toLowerCase() === address.toLowerCase()))
        throw error;
    }
  }
}

export async function getActiveWalletData(telegramId) {
  const { getDefaultWallet } = await import('./db.js');
  const w = await getDefaultWallet(telegramId);
  if (w) return unlockStoredWallet(w);
  return deriveUserWallet(telegramId);
}

function unlockStoredWallet(w) {
  try {
    const privateKey = decryptKey(w.encrypted_pk);
    if (new ethers.Wallet(privateKey).address.toLowerCase() !== w.address.toLowerCase()) throw new Error();
    return { address:w.address, privateKey, name:w.name, id:w.id, sort_order:w.sort_order, walletType:w.wallet_type };
  } catch {
    throw new Error('Cannot safely unlock the selected wallet. Check it in Account. No trade was sent.');
  }
}

export async function getManualWalletData(telegramId) {
  const { getManualWallet } = await import('./db.js');
  const w = await getManualWallet(telegramId);
  if (!w) throw new Error('No Manual wallet enabled. Open My Wallet and enable Manual before trading.');
  return unlockStoredWallet(w);
}

export async function getManualWalletByIdData(telegramId, walletId) {
  const { getWallet } = await import('./db.js');
  const w = await getWallet(telegramId, walletId);
  if (!w || !w.is_manual) throw new Error('Selected Manual wallet is disabled or removed. No trade was sent.');
  return unlockStoredWallet(w);
}

export async function sendBnb(privateKey, toAddress, amountBnb, telegramId) {
  const signer = getSigner(privateKey);
  const value  = ethers.parseEther(String(amountBnb));
  if (!ethers.isAddress(toAddress) || value <= 0n) throw Error('Invalid transfer recipient or amount.');
  return withWalletSpend(signer, async () => {
    const { sendWalletTransfer } = await import('./walletTrading.js');
    const receipt = await sendWalletTransfer(signer, { target: toAddress, value, data: '0x' }, telegramId);
    return receipt.hash;
  });
}

export async function sendToken(privateKey, tokenCa, toAddress, amountWei, telegramId) {
  const signer = getSigner(privateKey);
  if (!ethers.isAddress(tokenCa) || !ethers.isAddress(toAddress) || BigInt(amountWei) <= 0n)
    throw Error('Invalid token transfer recipient or amount.');
  return withWalletSpend(signer, async () => {
    const erc20 = new ethers.Interface(['function transfer(address,uint256) returns(bool)']);
    const call = { target: tokenCa, value: 0n, data: erc20.encodeFunctionData('transfer', [toAddress, amountWei]) };
    const simulated = await signer.call({ to: tokenCa, data: call.data });
    if (simulated !== '0x' && !ethers.AbiCoder.defaultAbiCoder().decode(['bool'], simulated)[0])
      throw Error('Token rejected this transfer; no transaction sent.');
    const { sendWalletTransfer } = await import('./walletTrading.js');
    const receipt = await sendWalletTransfer(signer, call, telegramId);
    return receipt.hash;
  });
}

export function deriveUserWallet(telegramId) {
  const pk = process.env.BUZZO_BOT_MASTER_PRIVATE_KEY;
  if (!pk) throw new Error('BUZZO_BOT_MASTER_PRIVATE_KEY not set');
  const seed = crypto.createHmac('sha256', pk)
    .update(`buzzo-user-${telegramId}`)
    .digest('hex');
  const derivedKey = '0x' + seed;
  const wallet = new ethers.Wallet(derivedKey);
  return {
    address: wallet.address,
    privateKey: derivedKey,
  };
}

const BSC_NETWORK = { name: 'bnb', chainId: 56 };

export function getProvider() {
  const rpc = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';
  const provider = new ethers.JsonRpcProvider(rpc, BSC_NETWORK, { staticNetwork: true });
  // PublicNode gates history reads, including recently mined receipts.
  // Preserve its live-state RPC; use BSC's public history RPC for receipt lookup.
  if (/^https:\/\/bsc-rpc\.publicnode\.com\/?$/i.test(rpc)) {
    const history = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/',BSC_NETWORK,{staticNetwork:true});
    provider.getTransactionReceipt = hash => history.getTransactionReceipt(hash);
    provider.getTransaction = hash => history.getTransaction(hash);
  }
  return provider;
}

export function getSigner(privateKey) {
  return new ethers.Wallet(privateKey, getProvider());
}

export async function getBnbBalance(address) {
  const provider = getProvider();
  const bal = await provider.getBalance(address);
  return parseFloat(ethers.formatEther(bal));
}

// Known BSC tokens always checked on-chain (no external API needed)
const KNOWN_TOKENS = [
  ...(process.env.BUZZO_NATIVE_TOKEN_CA ? [{ ca: process.env.BUZZO_NATIVE_TOKEN_CA, symbol: 'BUZZO' }] : []),
  { ca: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT'   },
  { ca: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC'   },
  { ca: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD'   },
  { ca: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB'   },
  { ca: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE'   },
  { ca: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH'    },
  { ca: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB'   },
];

const MIN_LIQUIDITY_USD = 100; // lowered — was 500 // tokens below this are likely spam/rugs
const KNOWN_CAS = new Set(KNOWN_TOKENS.map(t => t.ca.toLowerCase()));

const FLAP_RE = /^0x[0-9a-f]{36}(7777|8888)$/i;

async function filterByLiquidity(tokens) {
  if (!tokens.length) return tokens;
  // Always keep tokens we explicitly know and trust
  const trusted   = tokens.filter(t => KNOWN_CAS.has(t.ca.toLowerCase()));
  const rest      = tokens.filter(t => !KNOWN_CAS.has(t.ca.toLowerCase()));

  // Always keep Flap.sh bonding-curve tokens (ends 7777 or 8888) — they have no PancakeSwap pair
  const flapTokens = rest.filter(t => FLAP_RE.test(t.ca));
  const untrusted  = rest.filter(t => !FLAP_RE.test(t.ca));
  if (!untrusted.length) return [...trusted, ...flapTokens].sort((a, b) => b.formatted - a.formatted);

  // Batch DexScreener query (max 30 addresses at once)
  const liquidTokens = [];
  const batchSize = 30;
  for (let i = 0; i < untrusted.length; i += batchSize) {
    const batch = untrusted.slice(i, i + batchSize);
    const cas   = batch.map(t => t.ca).join(',');
    try {
      const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${cas}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pairsByCa = {};
      for (const pair of (data.pairs || [])) {
        if (pair.chainId !== 'bsc') continue;
        const dexId = (pair.dexId || '').toLowerCase();
        if (!dexId.includes('pancakeswap') && !dexId.includes('pancake')) continue;
        const ca  = (pair.baseToken?.address || '').toLowerCase();
        const liq = pair.liquidity?.usd || 0;
        pairsByCa[ca] = Math.max(pairsByCa[ca] || 0, liq);
      }
      for (const t of batch) {
        if ((pairsByCa[t.ca.toLowerCase()] || 0) >= MIN_LIQUIDITY_USD) {
          liquidTokens.push(t);
        }
      }
    } catch { /* skip batch on error */ }
  }
  return [...trusted, ...flapTokens, ...liquidTokens].sort((a, b) => b.formatted - a.formatted);
}

export async function getWalletTokens(address, extraCAs = [], hiddenCAs = []) {
  // Primary: Moralis — returns ALL BEP-20 tokens held
  const MORALIS_KEY = process.env.MORALIS_API_KEY;
  if (MORALIS_KEY) {
    try {
      const res = await fetch(
        `https://deep-index.moralis.io/api/v2.2/${address}/erc20?chain=bsc`,
        { headers: { 'X-API-Key': MORALIS_KEY } }
      );
      if (res.ok) {
        const data = await res.json();
        const tokens = (Array.isArray(data) ? data : (data.result || []))
          .filter(t => t.balance && BigInt(t.balance) > 0n && (!t.possible_spam || FLAP_RE.test(t.token_address)))
          .map(t => ({
            symbol:    t.symbol        || '???',
            name:      t.name          || '',
            formatted: parseFloat(ethers.formatUnits(t.balance, Number(t.decimals) || 18)),
            ca:        t.token_address,
          }))
          .filter(t => t.formatted > 0);
        const filtered = await filterByLiquidity(tokens);
        const hiddenSet = new Set(hiddenCAs.map(c => c.toLowerCase()));
        const visible = filtered.filter(t => !hiddenSet.has(t.ca.toLowerCase()));
        if (visible.length > 0) return visible;
      }
    } catch { /* fall through to on-chain fallback */ }
  }

  // Fallback: check known tokens + any extra CAs directly on-chain
  const provider = getProvider();
  const abi = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ];
  const seenCAs = new Set(KNOWN_TOKENS.map(t => t.ca.toLowerCase()));
  const allTokens = [...KNOWN_TOKENS];
  for (const ca of extraCAs) {
    if (ca && !seenCAs.has(ca.toLowerCase())) {
      allTokens.push({ ca, symbol: null });
      seenCAs.add(ca.toLowerCase());
    }
  }
  const results = await Promise.allSettled(
    allTokens.map(async ({ ca }) => {
      const contract = new ethers.Contract(ca, abi, provider);
      const [balance, decimals, symbol] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals(),
        contract.symbol(),
      ]);
      const formatted = parseFloat(ethers.formatUnits(balance, decimals));
      return { ca, symbol, formatted };
    })
  );
  const hiddenSet2 = new Set(hiddenCAs.map(c => c.toLowerCase()));
  return results
    .filter(r => r.status === 'fulfilled' && r.value.formatted > 0)
    .map(r => r.value)
    .filter(t => !hiddenSet2.has(t.ca.toLowerCase()))
    .sort((a, b) => b.formatted - a.formatted);
}

export async function getTokenBalance(walletAddress, tokenCa) {
  const provider = getProvider();
  const abi = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ];
  const contract = new ethers.Contract(tokenCa, abi, provider);
  const [balance, decimals, symbol] = await Promise.all([
    contract.balanceOf(walletAddress),
    contract.decimals(),
    contract.symbol(),
  ]);
  return {
    raw: balance,
    formatted: parseFloat(ethers.formatUnits(balance, decimals)),
    decimals: Number(decimals),
    symbol,
  };
}
