import crypto from 'crypto';

let goplusToken = null;
let goplusTokenExpiry = 0;

async function getGoPlusToken() {
  if (goplusToken && Date.now() < goplusTokenExpiry - 60000) return goplusToken;
  const appId = process.env.GOPLUS_APP_ID;
  const appSecret = process.env.GOPLUS_APP_SECRET;
  if (!appId || !appSecret) return null;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', appSecret).update(appId + timestamp).digest('hex');
    const res = await fetch('https://api.gopluslabs.io/api/v1/token/get_access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, sign, time: timestamp }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 1 || !data.result?.access_token) return null;
    goplusToken = data.result.access_token;
    goplusTokenExpiry = Date.now() + (data.result.expires_in || 3600) * 1000;
    console.log('[GOPLUS] Access token refreshed');
    return goplusToken;
  } catch (e) {
    console.error('[GOPLUS] Token fetch error:', e.message);
    return null;
  }
}

export async function scanToken(ca) {
  const token = await getGoPlusToken();
  const headers = token ? { Authorization: token } : {};

  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${ca.toLowerCase()}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[GOPLUS] HTTP ${res.status} for ${ca}`);
      return null;
    }
    const data = await res.json();
    const result = data.result?.[ca.toLowerCase()];
    if (!result) {
      console.warn(`[GOPLUS] No data for ${ca} — will use AI-only scan`);
      return null;
    }

    return {
      isHoneypot: result.is_honeypot === '1',
      isMintable: result.is_mintable === '1',
      isProxy: result.is_proxy === '1',
      isBlacklisted: result.is_blacklisted === '1',
      buyTax: result.buy_tax != null ? parseFloat(result.buy_tax) * 100 : null,
      sellTax: result.sell_tax != null ? parseFloat(result.sell_tax) * 100 : null,
      holderCount: result.holder_count ? parseInt(result.holder_count) : null,
      ownerPercent: result.owner_percent ? parseFloat(result.owner_percent) * 100 : null,
      cannotSell: result.cannot_sell_all === '1',
      tradingCooldown: result.trading_cooldown === '1',
      creatorPercent: result.creator_percent ? parseFloat(result.creator_percent) * 100 : null,
      lpLocked: result.lp_locked === '1',
      lpLockedPercent: result.lp_lock_ratio ? parseFloat(result.lp_lock_ratio) * 100 : null,
      name: result.token_name || '?',
      symbol: result.token_symbol || '?',
      totalSupply: result.total_supply || null,
      raw: result,
    };
  } catch (e) {
    console.warn('[GOPLUS] scanToken error:', e.message);
    return null;
  }
}

export function formatScanResult(scan, ca) {
  const risk = [];
  if (scan.isHoneypot) risk.push('🚨 HONEYPOT');
  if (scan.cannotSell) risk.push('🚨 CANNOT SELL');
  if (scan.isMintable) risk.push('⚠️ Mintable');
  if (scan.isBlacklisted) risk.push('⚠️ Blacklist function');
  if (scan.tradingCooldown) risk.push('⚠️ Trading cooldown');
  if (scan.buyTax > 10) risk.push(`⚠️ Buy tax ${scan.buyTax.toFixed(1)}%`);
  if (scan.sellTax > 10) risk.push(`⚠️ Sell tax ${scan.sellTax.toFixed(1)}%`);
  if (scan.ownerPercent > 5) risk.push(`⚠️ Owner holds ${scan.ownerPercent.toFixed(1)}%`);

  const riskLevel = scan.isHoneypot || scan.cannotSell ? '🔴 HIGH RISK' :
    risk.length > 2 ? '🟡 MEDIUM RISK' : '🟢 LOOKS OK';

  return `🔍 *Token Scan: ${scan.symbol}*

${riskLevel}
${risk.length > 0 ? risk.join('\n') : '✅ No major issues found'}

📊 *Details*
• Buy Tax: ${scan.buyTax != null ? scan.buyTax.toFixed(1) + '%' : '?'}
• Sell Tax: ${scan.sellTax != null ? scan.sellTax.toFixed(1) + '%' : '?'}
• Holders: ${scan.holderCount?.toLocaleString() || '?'}
• LP Locked: ${scan.lpLocked ? `✅ ${scan.lpLockedPercent?.toFixed(0) || '?'}%` : '❌ No'}
• Mintable: ${scan.isMintable ? '⚠️ Yes' : '✅ No'}

\`${ca}\``;
}
