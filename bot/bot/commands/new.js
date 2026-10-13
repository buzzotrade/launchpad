import { getNewTokens, formatTokenList } from '../lib/tokens.js';

export async function handleNew(ctx) {
  const msg = await ctx.reply('🔄 Fetching latest tokens...');
  try {
    const tokens = await getNewTokens(5);
    const text = `🆕 *Latest Flap.sh Tokens*\n\n${formatTokenList(tokens)}\n\n_Use /scan <CA> to check any token_`;
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Failed to fetch tokens: ${e.message}`);
  }
}
