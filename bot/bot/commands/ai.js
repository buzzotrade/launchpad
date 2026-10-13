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

  const prompt = `You are a BSC token security analyst. Analyze this token and give a concise risk verdict.

TOKEN DATA:
Name: ${name} ($${symbol})
Price: ${price}
Market Cap: ${mcap}
Liquidity: ${liq}
Vol 24h: ${vol24h} (Buys: ${buys}, Sells: ${sells})
Price 1h: ${ch1h != null ? (ch1h > 0 ? '+' : '') + ch1h.toFixed(2) + '%' : 'N/A'}
Price 24h: ${ch24h != null ? (ch24h > 0 ? '+' : '') + ch24h.toFixed(2) + '%' : 'N/A'}

SECURITY (GoPlus):${hasGoPlus ? `
Honeypot: ${isHoneypot ? 'YES ⚠️' : 'No'}
Mintable: ${isMintable ? 'YES ⚠️' : 'No'}
Cannot Sell: ${cannotSell ? 'YES ⚠️' : 'No'}
Blacklist: ${isBlacklisted ? 'YES ⚠️' : 'No'}
Trading Cooldown: ${tradingCooldown ? 'YES' : 'No'}
Buy Tax: ${buyTax != null ? buyTax.toFixed(1) + '%' : '?'}
Sell Tax: ${sellTax != null ? sellTax.toFixed(1) + '%' : '?'}
LP Locked: ${lpLocked ? 'Yes (' + (lpLockedPercent?.toFixed(0) || '?') + '%)' : 'No'}
Holders: ${holderCount?.toLocaleString() || '?'}` : ' Not available in GoPlus database (possibly new/Flap.sh token)'}

Respond with EXACTLY this format (3 lines, no extra text):
RISK: [🟢 LOW / 🟡 MEDIUM / 🟠 HIGH / 🔴 CRITICAL]
VERDICT: [One sentence key finding about this token]
TIP: [One short actionable trading tip]`;

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
        max_tokens: 120,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[AI] OpenRouter error:', res.status, err);
      return null;
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('[AI] Error:', e.message);
    return null;
  }
}
