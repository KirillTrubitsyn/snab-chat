/**
 * Telegram Bot API — отправка уведомлений админам.
 * Прямые вызовы api.telegram.org (без n8n).
 */

import { ADMIN_NAMES_BY_NUMBER } from "./auth";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

const ADMIN_CHAT_IDS: string[] = [
  process.env.TELEGRAM_ADMIN_CHAT_ID_1 ?? "",
  process.env.TELEGRAM_ADMIN_CHAT_ID_2 ?? "",
  process.env.TELEGRAM_ADMIN_CHAT_ID_3 ?? "",
  process.env.TELEGRAM_ADMIN_CHAT_ID_4 ?? "",
].filter(Boolean);

// Reverse lookup: chat_id → { number, name }
const ADMIN_BY_CHAT_ID: Record<string, { number: number; name: string }> = {};
[
  process.env.TELEGRAM_ADMIN_CHAT_ID_1,
  process.env.TELEGRAM_ADMIN_CHAT_ID_2,
  process.env.TELEGRAM_ADMIN_CHAT_ID_3,
  process.env.TELEGRAM_ADMIN_CHAT_ID_4,
].forEach((chatId, i) => {
  if (chatId) {
    ADMIN_BY_CHAT_ID[chatId] = {
      number: i + 1,
      name: ADMIN_NAMES_BY_NUMBER[i + 1] ?? `Админ ${i + 1}`,
    };
  }
});

/** Получить админа по Telegram chat_id */
export function getAdminByChatId(chatId: string): { number: number; name: string } | null {
  return ADMIN_BY_CHAT_ID[chatId] ?? null;
}

function getMoscowTime(): string {
  return new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

/** Отправить сообщение одному получателю */
export async function sendTelegramMessage(
  text: string,
  chatId: string,
  replyMarkup?: Record<string, unknown>
): Promise<boolean> {
  if (!BOT_TOKEN || !chatId) return false;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
async function notifyAllAdmins(text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  if (ADMIN_CHAT_IDS.length === 0) return;
  await Promise.allSettled(ADMIN_CHAT_IDS.map((id) => sendTelegramMessage(text, id, replyMarkup)));
}

/** Ответить на callback_query */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch { /* ignore */ }
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

/** Уведомление о новом обращении в поддержку (с REF для ответа через ТГ) */
export async function notifySupportMessage(
  userName: string,
  message: string,
  organization?: string | null,
  supportMessageId?: string | null
): Promise<void> {
  const orgLine = organization ? `\n🏢 <b>Организация:</b> ${escapeHtml(organization)}` : "";
  const truncMsg = message.length > 1000 ? message.slice(0, 1000) + "..." : message;
  const refLine = supportMessageId ? `\n\n🔖 <code>REF:${supportMessageId}</code>` : "";
  const text =
    `📩 <b>Новое обращение в поддержку</b>\n\n` +
    `👤 <b>Пользователь:</b> ${escapeHtml(userName)}${orgLine}\n\n` +
    `💬 ${escapeHtml(truncMsg)}\n\n` +
    `🕐 ${getMoscowTime()}` +
    `${refLine}`;
  const replyMarkup = supportMessageId
    ? {
        inline_keyboard: [[
          { text: "✍️ Ответить", callback_data: `reply:${supportMessageId}` },
        ]],
      }
    : undefined;
  await notifyAllAdmins(text, replyMarkup);
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
