export async function showCommandsPage(ctx) {
  const text =
    `📋 <b>All Available Commands</b>\n\n` +
    `<b>🏠 Main</b>\n` +
    `/start — Open the main dashboard\n` +
    `/help — Show help guide\n\n` +
    `<b>💱 Trading</b>\n` +
    `/buy &lt;CA&gt; &lt;BNB&gt; — Buy a token\n` +
    `/sell &lt;CA&gt; &lt;%&gt; — Sell % of your tokens\n` +
    `/limit — View &amp; manage limit orders\n\n` +
    `<b>🎯 Automation</b>\n` +
    `/snipe &lt;CA&gt; [BNB] — Snipe a token launch\n` +
    `/alert &lt;CA&gt; &lt;Nx&gt; — Set a price alert\n` +
    `/cancel — Cancel all snipes &amp; alerts\n\n` +
    `<b>🔍 Research</b>\n` +
    `/scan &lt;CA&gt; — Security scan a token\n` +
    `/trending — Top trending tokens\n` +
    `/trending — Live Buzzo tokens and trading volume\n\n` +
    `<b>👛 Wallet</b>\n` +
    `/wallet — View wallet &amp; balance\n` +
    `/exportkey — Export private key\n` +
    `/clean — Reset language to English\n\n` +
    `<b>🎁 Rewards</b>\n` +
    `/referral — Referral rewards dashboard\n\n` +
    `<b>⚙️ Other</b>\n` +
    `/history — Trade history\n` +
    `/settings — Configure settings`;

  const msgId = ctx.callbackQuery?.message?.message_id;
  const kb = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_main' }]] };

  if (msgId) {
    return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, {
      parse_mode: 'HTML', reply_markup: kb,
    }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  }
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}
