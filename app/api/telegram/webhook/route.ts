import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getAdminByChatId, notifySupportReply } from "@/app/lib/telegram";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

/**
 * Telegram Webhook — обработка входящих сообщений от бота.
 * Админ может ответить на уведомление о поддержке прямо в Telegram.
 */
export async function POST(req: NextRequest) {
  // Проверка секрета (Telegram передаёт его в заголовке)
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

  // Обрабатываем только reply-сообщения
  const message = update?.message;
  if (!message?.reply_to_message?.text || !message.text) {
    return NextResponse.json({ ok: true });
  }

  // Проверяем, что отправитель — авторизованный админ
  const chatId = String(message.chat.id);
  const admin = getAdminByChatId(chatId);
  if (!admin) {
    console.log(`[Telegram Webhook] Ignored message from unauthorized chat: ${chatId}`);
    return NextResponse.json({ ok: true });
  }

  // Извлекаем ID обращения из оригинального сообщения (REF:uuid)
  const originalText = message.reply_to_message.text;
  const refMatch = originalText.match(/REF:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!refMatch) {
    // Не support-уведомление — игнорируем
    return NextResponse.json({ ok: true });
  }

  const supportMessageId = refMatch[1];
  const replyText = message.text.trim().slice(0, 5000);

  if (!replyText) {
    return NextResponse.json({ ok: true });
  }

  console.log(`[Telegram Webhook] Admin ${admin.name} (chat ${chatId}) replying to support ${supportMessageId}`);

  const supabase = createServiceClient();

  // Обновляем только open-обращения (не перезаписываем чужие ответы)
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
    // Может быть уже отвечено — не ошибка
    return NextResponse.json({ ok: true });
  }

  if (updated) {
    console.log(`[Telegram Webhook] Reply saved for user: ${updated.user_name}`);
    // Уведомляем других админов
    notifySupportReply(admin.name, updated.user_name, replyText).catch(() => {});
  }

  // Всегда 200 — иначе Telegram будет повторять запрос
  return NextResponse.json({ ok: true });
}
