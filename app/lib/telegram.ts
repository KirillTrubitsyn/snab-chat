/**
 * Telegram Bot API — отправка уведомлений админам.
 * Прямые вызовы api.telegram.org (без n8n).
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

const ADMIN_CHAT_IDS: string[] = [
  process.env.TELEGRAM_ADMIN_CHAT_ID_1 ?? "",
  process.env.TELEGRAM_ADMIN_CHAT_ID_2 ?? "",
  process.env.TELEGRAM_ADMIN_CHAT_ID_3 ?? "",
].filter(Boolean);

function getMoscowTime(): string {
  return new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

/** Отправить сообщение одному получателю */
async function sendTelegramMessage(text: string, chatId: string): Promise<boolean> {
  if (!BOT_TOKEN || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[Telegram] Ошибка отправки в ${chatId}: ${err}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[Telegram] Ошибка сети:`, e);
    return false;
  }
}

/** Отправить сообщение ВСЕМ админам параллельно */
async function notifyAllAdmins(text: string): Promise<void> {
  if (ADMIN_CHAT_IDS.length === 0) return;
  await Promise.allSettled(ADMIN_CHAT_IDS.map((id) => sendTelegramMessage(text, id)));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Уведомление о нецелевом запросе */
export async function notifyOffTopic(
  userName: string,
  query: string,
  category: string,
  categoryLabel: string,
  organization?: string | null
): Promise<void> {
  const truncated = query.length > 500 ? query.slice(0, 500) + "..." : query;
  const orgLine = organization ? `\n🏢 <b>Организация:</b> ${escapeHtml(organization)}` : "";
  const text =
    `⚠️ <b>Нецелевой запрос</b>\n\n` +
    `👤 <b>Пользователь:</b> ${escapeHtml(userName)}${orgLine}\n` +
    `📁 <b>Категория:</b> ${escapeHtml(categoryLabel)} (${escapeHtml(category)})\n\n` +
    `💬 <b>Запрос:</b>\n${escapeHtml(truncated)}\n\n` +
    `🕐 ${getMoscowTime()}`;
  await notifyAllAdmins(text);
}

/** Уведомление об ошибке */
export async function notifyError(
  errorType: string,
  errorMessage: string,
  userName?: string | null,
  endpoint?: string | null,
  organization?: string | null
): Promise<void> {
  const userLine = userName ? `\n👤 <b>Пользователь:</b> ${escapeHtml(userName)}` : "";
  const orgLine = organization ? `\n🏢 <b>Организация:</b> ${escapeHtml(organization)}` : "";
  const endpointLine = endpoint ? `\n🔗 <b>Endpoint:</b> ${escapeHtml(endpoint)}` : "";
  const truncMsg = errorMessage.length > 1000 ? errorMessage.slice(0, 1000) + "..." : errorMessage;
  const text =
    `🔴 <b>Ошибка: ${escapeHtml(errorType)}</b>\n` +
    `${userLine}${orgLine}${endpointLine}\n\n` +
    `📝 ${escapeHtml(truncMsg)}\n\n` +
    `🕐 ${getMoscowTime()}`;
  await notifyAllAdmins(text);
}

/** Уведомление о новом обращении в поддержку */
export async function notifySupportMessage(
  userName: string,
  message: string,
  organization?: string | null
): Promise<void> {
  const orgLine = organization ? `\n🏢 <b>Организация:</b> ${escapeHtml(organization)}` : "";
  const truncMsg = message.length > 1000 ? message.slice(0, 1000) + "..." : message;
  const text =
    `📩 <b>Новое обращение в поддержку</b>\n\n` +
    `👤 <b>Пользователь:</b> ${escapeHtml(userName)}${orgLine}\n\n` +
    `💬 ${escapeHtml(truncMsg)}\n\n` +
    `🕐 ${getMoscowTime()}`;
  await notifyAllAdmins(text);
}

/** Уведомление об ответе на обращение (чтобы все админы видели) */
export async function notifySupportReply(
  adminName: string,
  userName: string,
  reply: string
): Promise<void> {
  const truncReply = reply.length > 1000 ? reply.slice(0, 1000) + "..." : reply;
  const text =
    `✅ <b>Ответ на обращение</b>\n\n` +
    `👤 <b>Пользователь:</b> ${escapeHtml(userName)}\n` +
    `🛡 <b>Ответил:</b> ${escapeHtml(adminName)}\n\n` +
    `💬 ${escapeHtml(truncReply)}\n\n` +
    `🕐 ${getMoscowTime()}`;
  await notifyAllAdmins(text);
}
