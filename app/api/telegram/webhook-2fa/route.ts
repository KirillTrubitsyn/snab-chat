import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { send2FAMessage } from "@/app/lib/telegram";
import { timingSafeEqual } from "crypto";
import { getMoscowTime } from "@/app/lib/date-utils";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.TELEGRAM_2FA_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || "";
const BOT_2FA_TOKEN = process.env.TELEGRAM_2FA_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";

/** Ответить на callback_query через 2FA-бот */
async function answer2FACallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  if (!BOT_2FA_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_2FA_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch { /* ignore */ }
}

/** Отредактировать сообщение через 2FA-бот */
async function edit2FAMessage(chatId: string, messageId: number, text: string): Promise<void> {
  if (!BOT_2FA_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_2FA_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }),
    });
  } catch { /* ignore */ }
}

/** Уведомить всех админов */
async function notifyAllAdmins(text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  const chatIds = [
    process.env.TELEGRAM_ADMIN_CHAT_ID_1,
    process.env.TELEGRAM_ADMIN_CHAT_ID_2,
    process.env.TELEGRAM_ADMIN_CHAT_ID_3,
    process.env.TELEGRAM_ADMIN_CHAT_ID_4,
  ].filter(Boolean) as string[];
  await Promise.allSettled(chatIds.map(async (chatId) => {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  }));
}

/**
 * POST /api/telegram/webhook-2fa — вебхук 2FA-бота (@SC2FA_Bot).
 * Обрабатывает:
 * 1. callback_query — кнопки подтверждения входа (Да/Нет)
 * 2. message — 6-значный OTP-код для привязки Telegram
 */
export async function POST(req: NextRequest) {
  if (!WEBHOOK_SECRET) {
    console.error("[Telegram 2FA Webhook] Webhook secret is not configured");
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

  // ── Обработка callback_query (кнопки подтверждения входа) ──
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    const chatId = String(callbackQuery.message?.chat?.id ?? "");
    const cbData = callbackQuery.data ?? "";
    const messageId = callbackQuery.message?.message_id;

    if (cbData.startsWith("login_approve:") || cbData.startsWith("login_deny:")) {
      const approvalId = cbData.split(":")[1];
      const approved = cbData.startsWith("login_approve:");
      const supabase = createServiceClient();

      const { data: approval, error: fetchErr } = await supabase
        .from("login_approvals")
        .select("id, invite_code_id, status, ip_address, expires_at")
        .eq("id", approvalId)
        .single();

      if (fetchErr || !approval) {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос не найден");
        return NextResponse.json({ ok: true });
      }

      const { data: invite } = await supabase
        .from("invite_codes")
        .select("telegram_chat_id, name")
        .eq("id", approval.invite_code_id)
        .single();

      if (!invite || invite.telegram_chat_id !== chatId) {
        await answer2FACallbackQuery(callbackQuery.id, "Нет доступа");
        return NextResponse.json({ ok: true });
      }

      if (approval.status !== "pending") {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос уже обработан");
        return NextResponse.json({ ok: true });
      }

      if (new Date(approval.expires_at) < new Date()) {
        await answer2FACallbackQuery(callbackQuery.id, "Время подтверждения истекло");
        return NextResponse.json({ ok: true });
      }

      const newStatus = approved ? "approved" : "denied";
      const { data: updated, error: updateErr } = await supabase
        .from("login_approvals")
        .update({ status: newStatus, resolved_at: new Date().toISOString() })
        .eq("id", approvalId)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (updateErr || !updated) {
        // Уже обработано другим запросом (race condition)
        await answer2FACallbackQuery(callbackQuery.id, "Запрос уже обработан");
        return NextResponse.json({ ok: true });
      }

      if (approved) {
        await answer2FACallbackQuery(callbackQuery.id, "Вход подтверждён");
        if (messageId) {
          await edit2FAMessage(chatId, messageId,
            `✅ <b>Вход подтверждён</b>\n\n👤 ${invite.name}\n🕐 ${getMoscowTime()}`
          );
        }
      } else {
        await answer2FACallbackQuery(callbackQuery.id, "Вход отклонён");
        if (messageId) {
          await edit2FAMessage(chatId, messageId,
            `❌ <b>Вход отклонён</b>\n\n👤 ${invite.name}\n🌐 ${approval.ip_address || "unknown"}\n🕐 ${getMoscowTime()}`
          );
        }
        const alertText =
          `🚨 <b>Подозрительная попытка входа</b>\n\n` +
          `Пользователь <b>${invite.name}</b> отклонил вход:\n` +
          `🌐 IP: ${approval.ip_address || "unknown"}\n` +
          `🕐 ${getMoscowTime()}\n\n` +
          `Возможно, кто-то пытается войти в чужой аккаунт.`;
        notifyAllAdmins(alertText).catch(() => {});
      }

      console.log(`[2FA Webhook] Login ${newStatus} for ${invite.name} (approval ${approvalId})`);
      return NextResponse.json({ ok: true });
    }

    await answer2FACallbackQuery(callbackQuery.id);
    return NextResponse.json({ ok: true });
  }

  // ── Обработка текстовых сообщений (OTP-коды для привязки) ──
  const message = update?.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const messageText = message.text.trim();

  // Handle /start — show instructions
  if (messageText === "/start" || messageText.startsWith("/start ")) {
    await send2FAMessage(
      "🔐 <b>СнабЧат — привязка Telegram</b>\n\n" +
      "Для привязки Telegram к вашему аккаунту:\n" +
      "1. Откройте настройки на сайте СнабЧат\n" +
      "2. Нажмите «Включить» напротив Telegram\n" +
      "3. Скопируйте 6-значный код\n" +
      "4. Отправьте его сюда в этот чат",
      chatId
    );
    return NextResponse.json({ ok: true });
  }

  // Handle 6-digit OTP code
  const codeMatch = messageText.match(/^\d{6}$/);
  if (codeMatch) {
    const code = codeMatch[0];
    const supabase = createServiceClient();

    // Look up OTP code of type "telegram"
    const { data: otpRecord, error } = await supabase
      .from("otp_codes")
      .select("id, invite_code_id, expires_at")
      .eq("code", code)
      .eq("method", "telegram")
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !otpRecord) {
      await send2FAMessage("❌ Неверный или просроченный код. Запросите новый в настройках.", chatId);
      return NextResponse.json({ ok: true });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      await send2FAMessage("❌ Код истёк. Запросите новый в настройках СнабЧат.", chatId);
      return NextResponse.json({ ok: true });
    }

    // Link telegram_chat_id to user
    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ telegram_chat_id: chatId })
      .eq("id", otpRecord.invite_code_id);

    if (updateError) {
      console.error("[Telegram 2FA Webhook] Link error:", updateError.message);
      await send2FAMessage("❌ Ошибка привязки. Попробуйте ещё раз.", chatId);
      return NextResponse.json({ ok: true });
    }

    // Mark OTP as used
    await supabase
      .from("otp_codes")
      .update({ used: true })
      .eq("id", otpRecord.id);

    await send2FAMessage(
      "✅ Telegram успешно привязан к вашему аккаунту СнабЧат!\n\nТеперь вы будете получать коды для входа через этот чат.",
      chatId
    );

    return NextResponse.json({ ok: true });
  }

  // Unknown message
  await send2FAMessage(
    "Отправьте 6-значный код из настроек СнабЧат для привязки Telegram.",
    chatId
  );
  return NextResponse.json({ ok: true });
}
