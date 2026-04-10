import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { send2FAMessage } from "@/app/lib/telegram";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.TELEGRAM_2FA_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || "";

/**
 * POST /api/telegram/webhook-2fa — вебхук 2FA-бота (@SC2FA_Bot).
 * Пользователь отправляет 6-значный код боту для привязки Telegram.
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
