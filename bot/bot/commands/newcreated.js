import { fetchPlatformTokens } from '../lib/platform.js';

// chatId -> { msgId, telegram, timer }
const activeWatchers = new Map();

function fmtMcap(usd) {
  if (!usd || usd === 0) return '?';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

function fmtAge(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

async function fetchNew() {
  return (await fetchPlatformTokens())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
}

function buildText(tokens, live = false) {
  if (!tokens.length) return '📭 No newly created tokens found right now.';

  const liveTag = live ? ' 🔴 LIVE' : '';
  const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const lines = tokens.map((t, i) => {
    const name = t.name   || 'Unknown';
    const tick = t.ticker || '???';
    const mcap = fmtMcap(t.mcap);
    const age  = fmtAge(t.createdAt);
    const prog = t.bondProgress > 0 ? ` | Bond: ${t.bondProgress.toFixed(0)}%` : '';
    const hold = t.holders > 0 ? ` | 👥 ${t.holders}` : '';
    const link = `<a href="${t.url}">Buzzo</a>`;
    return (
      `${i + 1}. 🆕 <b>${name}</b> ($${tick})\n` +
      `   MCap: ${mcap}${prog}${hold} · ${age}\n` +
      `   <code>${t.address}</code> · ${link}`
    );
  });

  return (
    `🆕 <b>New Tokens on flap.sh (BSC)</b>${liveTag}\n` +
    `<i>Updated: ${ts}${live ? ' — auto-refresh every 30s' : ''}</i>\n\n` +
    `${lines.join('\n\n')}`
  );
}

const STOP_KB = { inline_keyboard: [[{ text: '⏹ Stop Watching', callback_data: 'newcreated_stop' }]] };
const RESUME_KB = {
  inline_keyboard: [
    [{ text: '▶️ Resume Watching', callback_data: 'newcreated_resume' }],
    [{ text: '❌ Close',           callback_data: 'close_msg'          }],
  ],
};

function stopWatcher(chatId) {
  const w = activeWatchers.get(chatId);
  if (w) { clearInterval(w.timer); activeWatchers.delete(chatId); }
}

function startWatcher(chatId, msgId, telegram) {
  stopWatcher(chatId);
  const timer = setInterval(async () => {
    try {
      const tokens = await fetchNew();
      await telegram.editMessageText(chatId, msgId, null, buildText(tokens, true), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: STOP_KB,
      }).catch(() => stopWatcher(chatId));
    } catch { stopWatcher(chatId); }
  }, 30000);
  activeWatchers.set(chatId, { msgId, telegram, timer });
}

export function stopNewCreatedWatcher(chatId) { stopWatcher(chatId); }

export async function handleNewCreated(ctx) {
  const chatId = ctx.chat.id;
  stopWatcher(chatId);

  const msg = await ctx.reply('🔄 Loading new tokens from flap.sh...');
  try {
    const tokens = await fetchNew();
    await ctx.telegram.editMessageText(chatId, msg.message_id, null, buildText(tokens, true), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: STOP_KB,
    });
    startWatcher(chatId, msg.message_id, ctx.telegram);
  } catch (e) {
    await ctx.telegram.editMessageText(chatId, msg.message_id, null,
      `❌ Failed to load new tokens: ${e.message}`
    ).catch(() => {});
  }
}

export async function handleNewCreatedStop(ctx) {
  const chatId = ctx.chat.id;
  stopWatcher(chatId);
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!msgId) return ctx.reply('⏹ Watching stopped.').catch(() => {});
  try {
    const tokens = await fetchNew();
    await ctx.telegram.editMessageText(chatId, msgId, null, buildText(tokens, false), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: RESUME_KB,
    });
  } catch {}
}

export async function handleNewCreatedResume(ctx) {
  const chatId = ctx.chat.id;
  const msgId  = ctx.callbackQuery?.message?.message_id;
  if (!msgId) return handleNewCreated(ctx);

  stopWatcher(chatId);
  try {
    const tokens = await fetchNew();
    await ctx.telegram.editMessageText(chatId, msgId, null, buildText(tokens, true), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: STOP_KB,
    });
    startWatcher(chatId, msgId, ctx.telegram);
  } catch {}
}
