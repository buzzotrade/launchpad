export async function handleHelp(ctx) {
  const text = `*Buzzo Trade Bot*
_Fast, secure token trading on BNB Chain_

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
👛 *WALLET MANAGEMENT*

/start — Dashboard & wallet overview
/wallet — View address, balance & keys
/exportkey — Export your private key ⚠️

➤ *My Wallet* — Manage multiple wallets
➤ *Account* — Add, rename or switch wallets
➤ *Receive* — Show QR code & deposit address

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
💱 *TRADING*

➤ *Paste any CA* to open the full trade panel

/buy \`<CA>\` \`<BNB>\` — Buy a token with BNB
/sell \`<CA>\` \`<percent>\` — Sell % of your holdings

• Supports PancakeSwap & other routers
• Per-token slippage & gas control in the trade panel
• Auto Sell (Take Profit / Stop Loss) built-in

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
📋 *LIMIT ORDERS*

/limit — View & manage limit orders
➤ *Limit Orders* button — Set buy/sell triggers
• Executes automatically when price is hit

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
⚡ *AUTOMATION*

/snipe \`<CA>\` \`[BNB]\` — Auto-buy on first on-chain trade
/alert \`<CA>\` \`<2x>\` — Notify when price hits target
/cancel — Cancel all active snipes & alerts

• Sniper watches for the token's first trade
• Alerts support any multiplier (e.g. 0.5x, 3x)

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
💸 *TIPPING*

/tip \`<amount>\` \`BNB|token\` \`@username\` — Tip tokens or BNB to any user
/tip \`<amount>\` _(reply to a message)_ — Tip the person you replied to

• Works in private chat, groups & channels
• No @username needed — just reply to their message
• New recipient? Reply or use their Telegram ID; /start opens their funded wallet
• 1 💸 added per $10 worth of configured BUZZO sent

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
🔍 *RESEARCH & DISCOVERY*

/scan \`<CA>\` — Security scan + AI risk analysis
/trending — Live Buzzo tokens from the official website

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
📊 *HISTORY & SETTINGS*

/history — Full trade history
/settings — Global slippage, gas mode & preferences

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
_Powered by @Buzzotrade_bot_`;

  // Static content only: HTML avoids unbalanced underscores in @Buzzotrade_bot.
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^_(.*)_$/gm, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*([^*]+)\*/g, '<b>$1</b>')
    .replace(/_\(reply to a message\)_/g, '<i>(reply to a message)</i>');
  await ctx.reply(html, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Close', callback_data: 'close_msg' }]],
    },
  });
}
