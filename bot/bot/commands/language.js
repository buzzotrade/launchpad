import { setUserLanguage } from '../lib/db.js';
import { t, getLangName, getLangFlag } from '../lib/i18n.js';

const LANGUAGES = [
  { code: 'en', label: '🇬🇧 English' },
  { code: 'zh', label: '🇨🇳 简体中文' },
  { code: 'id', label: '🇮🇩 Indonesia' },
  { code: 'vi', label: '🇻🇳 Tiếng Việt' },
  { code: 'ko', label: '🇰🇷 한국어' },
  { code: 'ja', label: '🇯🇵 日本語' },
  { code: 'ha', label: '🇳🇬 Hausa' },
  { code: 'hi', label: '🇮🇳 हिंदी' },
];

function langKeyboard() {
  const rows = [];
  for (let i = 0; i < LANGUAGES.length; i += 2) {
    const row = [{ text: LANGUAGES[i].label, callback_data: `set_lang_${LANGUAGES[i].code}` }];
    if (LANGUAGES[i + 1]) {
      row.push({ text: LANGUAGES[i + 1].label, callback_data: `set_lang_${LANGUAGES[i + 1].code}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'menu_main' }]);
  return { inline_keyboard: rows };
}

export async function showLanguagePicker(ctx, lang = 'en') {
  const text = t(lang, 'lang_select');
  const markup = langKeyboard();

  const msgId = ctx.callbackQuery?.message?.message_id;
  if (msgId) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup }).catch(() =>
      ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup })
    );
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup });
  }
}

export async function handleSetLanguage(ctx, telegramId, langCode, currentLang) {
  await setUserLanguage(telegramId, langCode);
  const newLang = langCode;
  await ctx.answerCbQuery(getLangFlag(newLang) + ' ' + getLangName(newLang)).catch(() => {});
  await ctx.editMessageText(t(newLang, 'lang_set'), { parse_mode: 'HTML' }).catch(() => {});
}
