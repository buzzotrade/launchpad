import { Telegram } from 'telegraf';
import { canNotifyUser, setNotificationsEnabled } from './db.js';

let installed = false;
export function installNotificationGuard() {
  if (installed) return;
  installed = true;
  const call = Telegram.prototype.callApi;
  Telegram.prototype.callApi = async function(method, payload, ...args) {
    const chatId = Number(payload?.chat_id);
    if (['sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAnimation'].includes(method) &&
        Number.isSafeInteger(chatId) && chatId > 0) {
      // Fail closed on database errors; do not deliver unwanted notifications.
      if (!await canNotifyUser(chatId)) return undefined;
    }
    try {
      return await call.call(this, method, payload, ...args);
    } catch (error) {
      if (error.response?.error_code === 403 && Number.isSafeInteger(chatId) && chatId > 0)
        await setNotificationsEnabled(chatId, false);
      throw error;
    }
  };
}
