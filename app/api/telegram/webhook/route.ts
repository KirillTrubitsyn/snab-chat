import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getAdminByChatId, notifySupportReply, answerCallbackQuery, sendReplyPrompt } from "@/app/lib/telegram";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

/** Извлечь REF:uuid из текста */
function extractRef(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/REF:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return m ? m[1] : null;
}

/** Сохранить ответ админа в БД */
async function saveAdminReply(supportMessageId: string, replyText: string, admin: { number: number; name: string }) {
  const supabase = createServiceClient();
  const { data: updated, error } = await supabase
    .from("support_messages")
    .update({
      admin_reply: replyText,
      admin_number: admin.number,
      status: "answered",
      replied_at: new Date().toISOString(),
    })
    .eq("id", supportMessageId)
    .eq("status", "open")
    .select("user_name")
    .single();

  if (error) {
    console.error(`[Telegram Webhook] DB update error:`, error.message);
    return null;
  }
  return updated;
}

/**
 * Telegram Webhook — обработка входящих сообщений от бота.
 * Поддерживает:
 * 1. Callback-кнопку "Ответить" → prompt с force_reply + REF
 * 2. Reply на сообщение с REF → сохраняет ответ в БД
 */
export async function POST(req: NextRequest) {
  // Проверка секрета
  if (WEBHOOK_SECRET) {
    const secret = req.headers.get("x-telegram-bot-api-secret-token");
    if (secret !== WEBHOOK_SECRET) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  let update;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  // ── Обработка нажатия inline-кнопки "Ответить" ──
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    const chatId = String(callbackQuery.message?.chat?.id ?? "");
    const admin = getAdminByChatId(chatId);
    if (!admin) {
      await answerCallbackQuery(callbackQuery.id, "Нет доступа");
      return NextResponse.json({ ok: true });
    }

    const data = callbackQuery.data ?? "";
    if (data.startsWith("reply:")) {
      const supportId = data.slice(6);
      await answerCallbackQuery(callbackQuery.id);

      // Отправляем prompt с force_reply, reply к оригинальному уведомлению
      const originalMessageId = callbackQuery.message?.message_id;
      await sendReplyPrompt(
        chatId,
        `✍️ Напишите ответ на обращение:\n\n🔖 REF:${supportId}`,
        originalMessageId
      );

      console.log(`[Telegram Webhook] Reply prompt sent to admin ${admin.name}, support ${supportId}`);
    } else {
      await answerCallbackQuery(callbackQuery.id);
    }
    return NextResponse.json({ ok: true });
  }

  // ── Обработка сообщений от админа ──
  const message = update?.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const admin = getAdminByChatId(chatId);
  if (!admin) {
    return NextResponse.json({ ok: true });
  }

  // Ищем REF в reply_to_message (оригинальное уведомление или prompt от кнопки)
  const supportMessageId = extractRef(message.reply_to_message?.text);
  if (!supportMessageId) {
    return NextResponse.json({ ok: true });
  }

  const replyText = message.text.trim().slice(0, 5000);
  if (!replyText) {
    return NextResponse.json({ ok: true });
  }

  console.log(`[Telegram Webhook] Admin ${admin.name} (chat ${chatId}) replying to support ${supportMessageId}`);

  const updated = await saveAdminReply(supportMessageId, replyText, admin);
  if (updated) {
    console.log(`[Telegram Webhook] Reply saved for user: ${updated.user_name}`);
    notifySupportReply(admin.name, updated.user_name, replyText).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
