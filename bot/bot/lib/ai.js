const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-3-haiku';

export async function assessRisk(data) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const {
    name, symbol, price, mcap, liq, vol24h, buys, sells,
    buyTax, sellTax, isHoneypot, isMintable, lpLocked,
    lpLockedPercent, holderCount, isBlacklisted,
    tradingCooldown, cannotSell, ch1h, ch24h,
    hasGoPlus,
  } = data;

  const bsRatio  = (buys && sells && sells > 0) ? (buys / sells).toFixed(2) : null;
  const volLiqR  = (vol24h && liq) ? (parseFloat(vol24h.replace(/[^0-9.KMB]/g, '') || vol24h) / parseFloat(liq.replace(/[^0-9.KMB]/g, '') || liq)).toFixed(1) : null;
  const ch1hStr  = ch1h  != null ? `${ch1h  > 0 ? '+' : ''}${ch1h.toFixed(1)}%`  : 'N/A';
  const ch24hStr = ch24h != null ? `${ch24h > 0 ? '+' : ''}${ch24h.toFixed(1)}%` : 'N/A';

  const securityBlock = hasGoPlus
    ? `Buy Tax: ${buyTax != null ? buyTax.toFixed(1) + '%' : '?'} | Sell Tax: ${sellTax != null ? sellTax.toFixed(1) + '%' : '?'}
Honeypot: ${isHoneypot ? 'YES' : 'No'} | Mintable: ${isMintable ? 'YES' : 'No'} | Cannot Sell: ${cannotSell ? 'YES' : 'No'}
Blacklist fn: ${isBlacklisted ? 'YES' : 'No'} | Trading Cooldown: ${tradingCooldown ? 'YES' : 'No'}
LP Locked: ${lpLocked ? 'Yes (' + (lpLockedPercent?.toFixed(0) || '?') + '%)' : 'No'}
Holders: ${holderCount?.toLocaleString() || '?'}`
    : `(On-chain security data not available — analyze from market signals only)`;

  const prompt = `You are an expert BSC token analyst. Analyze this token and give a risk verdict.

TOKEN: ${name} ($${symbol})
Price: ${price} | MCap: ${mcap} | Liquidity: ${liq}
Vol 24h: ${vol24h} | Buys 24h: ${buys} | Sells 24h: ${sells}
Buy/Sell ratio: ${bsRatio ? bsRatio + 'x' : 'N/A'} (>1 = buy pressure, <1 = sell pressure)
Price 1h: ${ch1hStr} | Price 24h: ${ch24hStr}

SECURITY DATA:
${securityBlock}

Assess risk based on all available signals. For tokens without on-chain security data, use market behavior: volume/liquidity ratio, buy pressure, price stability, and holder patterns.

Respond in EXACTLY 3 lines, no extra text, no labels beyond RISK:
RISK: [🟢 LOW / 🟡 MEDIUM / 🟠 HIGH / 🔴 CRITICAL]
[One sentence — most important finding about this token right now]
[One short actionable tip for traders considering this token]`;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://buzzo.trade',
        'X-Title': 'Buzzo Bot',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 130,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      console.error('[AI] OpenRouter error:', res.status, await res.text());
      return null;
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('[AI] Error:', e.message);
    return null;
  }
}
