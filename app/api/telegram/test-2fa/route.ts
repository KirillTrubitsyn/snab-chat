import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { getMoscowTime } from "@/app/lib/date-utils";

/**
 * POST /api/telegram/test-2fa — проверка 2FA-бота.
 * Возвращает статус токена, webhook, и отправляет тестовое сообщение админу.
 */
export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const botToken = process.env.TELEGRAM_2FA_BOT_TOKEN;
  const botUsername = process.env.TELEGRAM_2FA_BOT_USERNAME || "";

  if (!botToken) {
    return NextResponse.json(
      { error: "TELEGRAM_2FA_BOT_TOKEN не задан в переменных окружения" },
      { status: 500 }
    );
  }

  const results: Record<string, unknown> = {
    bot_token_set: true,
    bot_username: botUsername,
  };

  // Проверить getMe
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = await meRes.json();
    if (meData.ok) {
      results.bot_info = {
        id: meData.result.id,
        username: meData.result.username,
        first_name: meData.result.first_name,
      };
      results.bot_username = meData.result.username;
    } else {
      results.bot_error = meData.description || "Токен невалидный";
      return NextResponse.json(results);
    }
  } catch (e) {
    results.bot_error = `Ошибка сети: ${e}`;
    return NextResponse.json(results);
  }

  // Проверить webhook
  try {
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const whData = await whRes.json();
    if (whData.ok) {
      results.webhook = {
        url: whData.result.url || null,
        has_custom_certificate: whData.result.has_custom_certificate,
        pending_update_count: whData.result.pending_update_count,
        last_error_date: whData.result.last_error_date || null,
        last_error_message: whData.result.last_error_message || null,
      };
    }
  } catch { /* ignore */ }

  // Отправить тестовое сообщение вызывающему админу
  // Используем первый admin chat id как тест
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID_1;
  if (adminChatId) {
    try {
      const text =
        `🧪 <b>Тест 2FA-бота СнабЧат</b>\n\n` +
        `✅ 2FA бот @${results.bot_username} работает\n` +
        `🕐 ${getMoscowTime()}`;

      const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: adminChatId,
          text,
          parse_mode: "HTML",
        }),
      });
      const sendData = await sendRes.json();
      results.test_send = {
        ok: sendData.ok,
        chat_id: adminChatId,
        error: sendData.ok ? null : sendData.description,
      };
    } catch (e) {
      results.test_send = { ok: false, chat_id: adminChatId, error: String(e) };
    }
  } else {
    results.test_send = { ok: false, error: "TELEGRAM_ADMIN_CHAT_ID_1 не задан" };
  }

  return NextResponse.json(results);
}
