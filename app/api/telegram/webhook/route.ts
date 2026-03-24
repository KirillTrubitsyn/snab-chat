import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getAdminByChatId, notifySupportReply, answerCallbackQuery, sendTelegramMessage } from "@/app/lib/telegram";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

/** Извлечь REF:uuid из текста */
function extractRef(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/REF:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return m ? m[1] : null;
}

/** Пометить обращение как "ожидающее ответ" от этого админа */
async function setPendingReply(supportMessageId: string, adminChatId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("support_messages")
    .update({ pending_admin_chat_id: adminChatId })
    .eq("id", supportMessageId)
    .eq("status", "open");
  if (error) {
    console.error(`[Telegram Webhook] setPendingReply error:`, error.message);
    return false;
  }
  return true;
}

/** Найти обращение, ожидающее ответ от этого админа */
async function findPendingReply(adminChatId: string): Promise<string | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("support_messages")
    .select("id")
    .eq("pending_admin_chat_id", adminChatId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[Telegram Webhook] findPendingReply error:`, error.message);
    return null;
  }
  return data?.id ?? null;
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
      pending_admin_chat_id: null, // сбросить pending
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
 * 1. Callback-кнопку "Ответить" → помечает обращение pending + prompt
 * 2. Reply на сообщение с REF → сохраняет ответ
 * 3. Обычное сообщение от админа с pending → сохраняет ответ
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

      // Помечаем обращение как ожидающее ответ от этого админа
      const ok = await setPendingReply(supportId, chatId);
      if (ok) {
        await answerCallbackQuery(callbackQuery.id, "Напишите ответ в следующем сообщении ✍️");
        await sendTelegramMessage(
          `✍️ Напишите ответ — следующее ваше сообщение будет отправлено пользователю.\n\n<i>Или ответьте Reply ↩️ на уведомление выше.</i>`,
          chatId
        );
        console.log(`[Telegram Webhook] Pending reply set: admin ${admin.name}, support ${supportId}`);
      } else {
        await answerCallbackQuery(callbackQuery.id, "Обращение уже закрыто или не найдено");
      }
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

  const replyText = message.text.trim().slice(0, 5000);
  if (!replyText) {
    return NextResponse.json({ ok: true });
  }

  // Путь 1: Reply на сообщение с REF
  let supportMessageId = extractRef(message.reply_to_message?.text);

  // Путь 2: Обычное сообщение → ищем pending
  if (!supportMessageId) {
    supportMessageId = await findPendingReply(chatId);
    if (supportMessageId) {
      console.log(`[Telegram Webhook] Matched pending reply for admin ${admin.name}`);
    }
  }

  if (!supportMessageId) {
    return NextResponse.json({ ok: true });
  }

  console.log(`[Telegram Webhook] Admin ${admin.name} replying to support ${supportMessageId}`);

  const updated = await saveAdminReply(supportMessageId, replyText, admin);
  if (updated) {
    console.log(`[Telegram Webhook] Reply saved for user: ${updated.user_name}`);
    // Подтверждение админу
    await sendTelegramMessage(`✅ Ответ отправлен пользователю ${updated.user_name}`, chatId);
    notifySupportReply(admin.name, updated.user_name, replyText).catch(() => {});
  } else {
    await sendTelegramMessage(`⚠️ Не удалось сохранить ответ — обращение уже закрыто или не найдено.`, chatId);
  }

  return NextResponse.json({ ok: true });
}
