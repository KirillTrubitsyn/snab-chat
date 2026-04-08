import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { sendTelegramMessage } from "@/app/lib/telegram";
import { getMoscowTime } from "@/app/lib/date-utils";

/**
 * POST /api/telegram/test — проверка отправки сообщений в Telegram.
 * Доступно только админам (X-Admin-Code).
 */
export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = [
    process.env.TELEGRAM_ADMIN_CHAT_ID_1,
    process.env.TELEGRAM_ADMIN_CHAT_ID_2,
    process.env.TELEGRAM_ADMIN_CHAT_ID_3,
    process.env.TELEGRAM_ADMIN_CHAT_ID_4,
  ];

  const results: Record<string, unknown> = {
    bot_token_set: !!botToken,
    chat_ids: chatIds.map((id, i) => ({
      name: `TELEGRAM_ADMIN_CHAT_ID_${i + 1}`,
      value: id || null,
      set: !!id,
    })),
    send_results: [],
  };

  if (!botToken) {
    return NextResponse.json({ ...results, error: "TELEGRAM_BOT_TOKEN не задан" }, { status: 500 });
  }

  const text =
    `🧪 <b>Тест уведомлений СнабЧат</b>\n\n` +
    `✅ Бот работает, сообщения доходят\n` +
    `🕐 ${getMoscowTime()}`;

  const sendResults = await Promise.all(
    chatIds.map(async (chatId, i) => {
      if (!chatId) return { id: `_${i + 1}`, chatId: null, status: "skipped" };
      // Direct API call to get error details
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        });
        const json = await res.json();
        return {
          id: `_${i + 1}`,
          chatId,
          status: res.ok ? "ok" : "error",
          telegram_response: json,
        };
      } catch (e) {
        return { id: `_${i + 1}`, chatId, status: "network_error", error: String(e) };
      }
    })
  );

  results.send_results = sendResults;
  return NextResponse.json(results);
}
