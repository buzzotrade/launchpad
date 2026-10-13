import { fetchPlatformTokens } from '../lib/platform.js';
import { SITE_URL } from '../config.js';
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = value => value == null ? 'Unavailable'
  : `$${Number(value).toLocaleString('en', { maximumFractionDigits: 2 })}`;

export function buildTrendingText(tokens) {
  if (!tokens.length) return `No live Buzzo tokens found yet.\n\n<a href="${SITE_URL}/explore">Explore Buzzo</a>`;
  const ranked = [...tokens].sort((a, b) =>
    (b.volume24h ?? -1) - (a.volume24h ?? -1) ||
    new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  return '<b>Trending on Buzzo · BSC</b>\nRanked by 24-hour trading volume\n\n' +
    ranked.map((token, i) =>
      `${i + 1}. <a href="${token.url}"><b>${esc(token.name)} (${esc(token.symbol)})</b></a>\n` +
      `Market cap: ${money(token.mcap)} · Volume: ${money(token.volume24h)}\n` +
      `<code>${token.address}</code>`).join('\n\n') +
    `\n\n<a href="${SITE_URL}/explore">Explore Buzzo</a>`;
}

export async function handleTrending(ctx, editMsgId = null) {
  const msgId = editMsgId || (await ctx.reply('Loading Buzzo trending tokens...')).message_id;
  try {
    const tokens = await fetchPlatformTokens();
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, buildTrendingText(tokens), {
      parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [
        [{ text: 'Refresh', callback_data: 'menu_trending' }],
        [{ text: 'Explore Buzzo', url: `${SITE_URL}/explore` }],
        [{ text: 'Close', callback_data: 'close_msg' }],
      ] },
    });
  } catch {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null,
      'Buzzo trending is temporarily unavailable. Please retry.', {
        reply_markup: { inline_keyboard: [
          [{ text: 'Retry', callback_data: 'menu_trending' }],
          [{ text: 'Explore Buzzo', url: `${SITE_URL}/explore` }],
        ] },
      }).catch(() => {});
  }
}
