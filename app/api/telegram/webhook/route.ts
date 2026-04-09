import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getAdminByChatId, notifySupportReply, answerCallbackQuery, sendTelegramMessage } from "@/app/lib/telegram";
import { timingSafeEqual } from "crypto";

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

/** Обработка /start команды для привязки Telegram (2FA) */
async function handleStartCommand(chatId: string, token: string): Promise<boolean> {
  if (!token || token.length < 10) return false;

  const supabase = createServiceClient();

  // Найти токен привязки
  const { data: linkToken, error } = await supabase
    .from("telegram_link_tokens")
    .select("id, invite_code_id, expires_at, used")
    .eq("token", token)
    .maybeSingle();

  if (error || !linkToken) {
    await sendTelegramMessage(
      "Недействительная ссылка. Пожалуйста, запросите новую ссылку в настройках СнабЧат.",
      chatId
    );
    return true;
  }

  if (linkToken.used) {
    await sendTelegramMessage(
      "Эта ссылка уже была использована. Запросите новую в настройках.",
      chatId
    );
    return true;
  }

  if (new Date(linkToken.expires_at) < new Date()) {
    await sendTelegramMessage(
      "Ссылка истекла. Пожалуйста, запросите новую ссылку в настройках СнабЧат.",
      chatId
    );
    return true;
  }

  // Привязать chat_id к аккаунту
  const { error: updateError } = await supabase
    .from("invite_codes")
    .update({ telegram_chat_id: chatId })
    .eq("id", linkToken.invite_code_id);

  if (updateError) {
    console.error("[Telegram Webhook] Error linking Telegram:", updateError.message);
    await sendTelegramMessage("Ошибка привязки. Попробуйте ещё раз.", chatId);
    return true;
  }

  // Пометить токен как использованный
  await supabase
    .from("telegram_link_tokens")
    .update({ used: true })
    .eq("id", linkToken.id);

  await sendTelegramMessage(
    "Telegram успешно привязан к вашему аккаунту СнабЧат!\n\nТеперь вы будете получать коды для входа через этот чат.",
    chatId
  );

  console.log(`[Telegram Webhook] Telegram linked for invite_code_id: ${linkToken.invite_code_id}`);
  return true;
}

/**
 * Telegram Webhook — обработка входящих сообщений от бота.
 * Поддерживает:
 * 1. /start <token> — привязка Telegram для 2FA
 * 2. Callback-кнопку "Ответить" → помечает обращение pending + prompt
 * 3. Reply на сообщение с REF → сохраняет ответ
 * 4. Обычное сообщение от админа с pending → сохраняет ответ
 */
export async function POST(req: NextRequest) {
  // Проверка секрета (обязательна)
  if (!WEBHOOK_SECRET) {
    console.error("[Telegram Webhook] TELEGRAM_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  try {
    const a = Buffer.from(secret, "utf8");
    const b = Buffer.from(WEBHOOK_SECRET, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 });
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

  // ── Обработка сообщений ──
  const message = update?.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const messageText = message.text.trim();

  // ── Обработка /start команды (привязка Telegram для 2FA) ──
  if (messageText.startsWith("/start ")) {
    const token = messageText.slice(7).trim();
    const handled = await handleStartCommand(chatId, token);
    if (handled) {
      return NextResponse.json({ ok: true });
    }
  }

  // Просто /start без параметра — приветствие
  if (messageText === "/start") {
    await sendTelegramMessage(
      "Добро пожаловать в бот СнабЧат!\n\nДля привязки Telegram к вашему аккаунту используйте ссылку из настроек на сайте snabchat.app.",
      chatId
    );
    return NextResponse.json({ ok: true });
  }

  // ── Далее только для админов ──
  const admin = getAdminByChatId(chatId);
  if (!admin) {
    // Не-админ прислал сообщение (не /start) — игнорируем
    return NextResponse.json({ ok: true });
  }

  const replyText = messageText.slice(0, 5000);
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
