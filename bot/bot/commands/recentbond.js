import { fetchPlatformTokens } from '../lib/platform.js';

function fmtMcap(usd) {
  if (!usd || usd <= 0) return '?';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function enrichMcap(tokens) {
  const results = await Promise.allSettled(
    tokens.map(async (t) => {
      const addr = t.pairAddr || t.address;
      if (!addr) return t;
      try {
        const url = t.pairAddr
          ? `https://api.dexscreener.com/latest/dex/pairs/bsc/${t.pairAddr}`
          : `https://api.dexscreener.com/latest/dex/tokens/${t.address}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) return t;
        const d = await r.json();
        const pair = t.pairAddr ? d.pair : d.pairs?.[0];
        if (!pair) return t;
        const mcap = pair.fdv || pair.marketCap || 0;
        return { ...t, mcap: parseFloat(mcap) || t.mcap || 0 };
      } catch (_) {
        return t;
      }
    })
  );
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : tokens[i]));
}

export async function handleRecentBond(ctx) {
  const msg = await ctx.reply('🔄 Loading recently bonded tokens...');
  try {
    let tokens   = (await fetchPlatformTokens()).filter(token => token.graduated).slice(0, 5);

    if (!tokens.length) {
      return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        '📭 No recently bonded tokens found.',
        { reply_markup: { inline_keyboard: [[{ text: '❌ Close', callback_data: 'close_msg' }]] } }
      );
    }

    tokens = await enrichMcap(tokens);

    const lines = tokens.map((t, i) => {
      const name  = t.name  || 'Unknown';
      const tick  = t.ticker || '???';
      const mcap  = fmtMcap(t.mcap);
      const hold  = t.holders > 0 ? ` | 👥 ${t.holders}` : '';
      const dated = t.graduatedAt
        ? ` · ${fmtDate(new Date(t.graduatedAt).toISOString())}`
        : (t.createdAt ? ` · ${fmtDate(t.createdAt)}` : '');
      const dex   = t.address ? `<a href="https://dexscreener.com/bsc/${t.address}">Chart</a>` : '';
      const buy   = t.address ? ` · <a href="https://flap.sh/bnb/${t.address}">Flap.sh</a>` : '';
      return (
        `${i + 1}. 🏆 <b>${name}</b> ($${tick})\n` +
        `   MCap: ${mcap}${hold}${dated}\n` +
        `   <code>${t.address}</code>\n` +
        `   ${dex}${buy}`
      );
    });

    const text = (
      `🎓 <b>Recently Listed on Buzzo (BSC)</b>\n` +
      `<i>Launched tokens with a liquidity pool</i>\n\n` +
      lines.join('\n\n')
    );

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'menu_recentbond' }],
          [{ text: '❌ Close',   callback_data: 'close_msg'        }],
        ],
      },
    });
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `❌ Failed to load recent bonds: ${e.message}`,
      { reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: 'menu_recentbond' }]] } }
    ).catch(() => {});
  }
}
