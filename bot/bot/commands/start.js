import { getBnbBalance, seedHdWalletIfNeeded, getActiveWalletData, getWalletTokens } from '../lib/walletLib.js';
import { getUser, createUser, getUserWallets, getUserLanguage, setReferredBy, restoreReferredBy, setNotificationsEnabled } from '../lib/db.js';
import { t } from '../lib/i18n.js';
import { showTokenPanel } from './buysell.js';
import { tokenFromStartPayload } from '../lib/startPayload.mjs';

const VERSION = 'v1.0.0';

function fmtTokenAmt(n, symbol) {
  let s;
  if (n >= 1_000_000) s = `${(n / 1_000_000).toFixed(2)}M`;
  else if (n >= 1)    s = n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  else if (n >= 0.01) s = n.toFixed(2);
  else                s = n.toExponential(2);
  return `${s} ${symbol}`;
}

export function mainMenu(lang = 'en') {
  return {
    inline_keyboard: [
      [
        { text: t(lang, 'btn_chain'),      callback_data: 'menu_chain' },
      ],
      [
        { text: t(lang, 'btn_buysell'),    callback_data: 'menu_buysell' },
        { text: t(lang, 'btn_wallet'),     callback_data: 'menu_wallet'  },
        { text: t(lang, 'btn_account'),    callback_data: 'menu_account' },
      ],
      [
        { text: t(lang, 'btn_limit'),      callback_data: 'menu_limit'   },
      ],
      [
        { text: t(lang, 'btn_history'),    callback_data: 'menu_history'    },
        { text: t(lang, 'btn_trending'),   callback_data: 'menu_trending'   },
      ],
      [
        { text: t(lang, 'btn_snipe'),      callback_data: 'menu_snipe'      },
        { text: t(lang, 'btn_alert'),      callback_data: 'menu_alert'      },
      ],
      [
        { text: t(lang, 'btn_scan'),       callback_data: 'menu_scan'    },
        { text: t(lang, 'btn_settings'),   callback_data: 'cfg_global'   },
      ],
      [
        { text: t(lang, 'btn_receive'),    callback_data: 'menu_receive' },
        { text: t(lang, 'btn_tip'),        callback_data: 'menu_tip'     },
      ],
      [
        { text: t(lang, 'btn_commands'),   callback_data: 'menu_commands' },
        { text: t(lang, 'btn_referral'),   callback_data: 'ref_main'      },
      ],
      [
        { text: t(lang, 'btn_language'),   callback_data: 'menu_language' },
        { text: t(lang, 'btn_docs'),       url: 'https://buzzo.trade/docs' },
      ],
      [
        { text: t(lang, 'btn_help'),       callback_data: 'menu_help'    },
        { text: t(lang, 'btn_cancel'),     callback_data: 'menu_cancel'  },
      ],
    ],
  };
}

export async function handleStart(ctx) {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'User';

  try {
    await createUser(telegramId, username, '');
    await setNotificationsEnabled(telegramId,true);

    await restoreReferredBy(telegramId).catch(() => {});
    const payload = ctx.startPayload || '';
    let deepLinkCA = tokenFromStartPayload(payload);
    if (payload.startsWith('ref_')) {
      const withoutPrefix = payload.slice(4);        // "5189577935" or "5189577935_0xCA"
      const sep = withoutPrefix.indexOf('_');
      const referrerId = parseInt(sep >= 0 ? withoutPrefix.slice(0, sep) : withoutPrefix);
      if (sep >= 0) {
        const possibleCA = withoutPrefix.slice(sep + 1);
        deepLinkCA = tokenFromStartPayload(possibleCA);
      }
      if (!isNaN(referrerId) && referrerId !== telegramId) {
        await setReferredBy(telegramId, referrerId).catch(() => {});
      }
    }

    await setReferredBy(telegramId, 5189577935).catch(() => {});

    const lang = await getUserLanguage(telegramId);

    const walletsBeforeSeed = await getUserWallets(telegramId);
    const isFirstStart = walletsBeforeSeed.length === 0;

    await seedHdWalletIfNeeded(telegramId);


    await ctx.reply('⏳', {
      reply_markup: { remove_keyboard: true },
    }).then(m => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id)).catch(() => {});

    let text;

    if (isFirstStart) {
      const wallet  = await getActiveWalletData(telegramId);
      const [balance, tokens] = await Promise.all([
        getBnbBalance(wallet.address).catch(() => 0),
        getWalletTokens(wallet.address).catch(() => []),
      ]);
      const tokenLines = tokens.length
        ? '\n' + tokens.map(tk => `  • ${fmtTokenAmt(tk.formatted, tk.symbol)}`).join('\n')
        : '';

      text =
        `${t(lang, 'welcome_title')}\n` +
        `${t(lang, 'welcome_network')}\n\n` +
        `${t(lang, 'welcome_address')}\n` +
        `<code>${wallet.address}</code>\n\n` +
        `${t(lang, 'welcome_balance')} ${Number(balance).toFixed(4)} BNB${tokenLines}\n\n` +
        `${t(lang, 'welcome_hint')}\n\n` +
        `🚀 <b>${VERSION}</b> — ${t(lang, 'version_bot')}\n` +
        `${t(lang, 'welcome_powered')}`;

      // Send PK in a separate message that auto-deletes in 60 seconds
      ctx.reply(
        `${t(lang, 'welcome_pk')} <tg-spoiler>${wallet.privateKey}</tg-spoiler>\n\n` +
        `${t(lang, 'welcome_pk_warn')}\n` +
        `<i>⏱ This message auto-deletes in 60 seconds.</i>`,
        { parse_mode: 'HTML' }
      ).then(pkMsg => {
        setTimeout(() => {
          ctx.telegram.deleteMessage(ctx.chat.id, pkMsg.message_id).catch(() => {});
        }, 60_000);
      }).catch(() => {});
    } else {
      const allWallets = await getUserWallets(telegramId);
      // Cap how many wallets we render inline — accounts with a large number
      // of legacy/imported wallet rows would otherwise blow past Telegram's
      // 4096-char message limit and make /start fail outright.
      const MAX_INLINE_WALLETS = 3;
      const defaultWallet = allWallets.find(w => w.is_default) || allWallets[0];
      const rest = allWallets.filter(w => w !== defaultWallet).slice(0, MAX_INLINE_WALLETS - 1);
      const wallets = defaultWallet ? [defaultWallet, ...rest] : allWallets.slice(0, MAX_INLINE_WALLETS);
      const extraCount = allWallets.length - wallets.length;

      const [balances, tokenLists] = await Promise.all([
        Promise.all(wallets.map(w => getBnbBalance(w.address).catch(() => 0))),
        Promise.all(wallets.map(w => getWalletTokens(w.address).catch(() => []))),
      ]);

      const walletLines = wallets.map((w, i) => {
        const tokenLines = tokenLists[i].length
          ? '\n' + tokenLists[i].slice(0, 5).map(tk => `  • ${fmtTokenAmt(tk.formatted, tk.symbol)}`).join('\n')
          : '';
        return (
          `${t(lang, 'welcome_address')}\n<code>${w.address}</code>\n` +
          `${t(lang, 'welcome_balance')} ${Number(balances[i]).toFixed(4)} BNB${tokenLines}`
        );
      }).join('\n\n');

      const moreNote = extraCount > 0
        ? `\n\n<i>+${extraCount} more wallet${extraCount === 1 ? '' : 's'} — see 💼 My Wallets</i>`
        : '';

      text =
        `${t(lang, 'welcome_title')}\n` +
        `${t(lang, 'welcome_network')}\n\n` +
        `${walletLines}${moreNote}\n\n` +
        `${t(lang, 'welcome_hint')}\n\n` +
        `🚀 <b>${VERSION}</b> — ${t(lang, 'version_bot')}\n` +
        `${t(lang, 'welcome_powered')}`;

      // Telegram hard-caps messages at 4096 chars — truncate defensively as
      // a last resort in case even the capped wallet list is still too long.
      if (text.length > 4000) {
        text = text.slice(0, 3900) + `\n\n<i>… truncated — see 💼 My Wallets for full list</i>`;
      }
    }

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: mainMenu(lang),
      disable_web_page_preview: true,
    });

    if (deepLinkCA) {
      await showTokenPanel(ctx, deepLinkCA).catch(e => console.error('[deepLinkCA] showTokenPanel failed:', e.message));
    }

  } catch (e) {
    console.error('[/start]', e.message);
    await ctx.reply('❌ Error setting up your wallet. Please try again.');
  }
}
