import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { send2FAMessage } from "@/app/lib/telegram";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.TELEGRAM_2FA_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || "";

/**
 * Обработка /start команды для привязки Telegram (2FA).
 */
async function handleStartCommand(chatId: string, token: string): Promise<boolean> {
  if (!token || token.length < 10) return false;

  const supabase = createServiceClient();

  const { data: linkToken, error } = await supabase
    .from("telegram_link_tokens")
    .select("id, invite_code_id, expires_at, used")
    .eq("token", token)
    .maybeSingle();

  if (error || !linkToken) {
    await send2FAMessage(
      "Недействительная ссылка. Пожалуйста, запросите новую ссылку в настройках СнабЧат.",
      chatId
    );
    return true;
  }

  if (linkToken.used) {
    await send2FAMessage(
      "Эта ссылка уже была использована. Запросите новую в настройках.",
      chatId
    );
    return true;
  }

  if (new Date(linkToken.expires_at) < new Date()) {
    await send2FAMessage(
      "Ссылка истекла. Пожалуйста, запросите новую ссылку в настройках СнабЧат.",
      chatId
    );
    return true;
  }

  const { error: updateError } = await supabase
    .from("invite_codes")
    .update({ telegram_chat_id: chatId })
    .eq("id", linkToken.invite_code_id);

  if (updateError) {
    console.error("[Telegram 2FA Webhook] Error linking Telegram:", updateError.message);
    await send2FAMessage("Ошибка привязки. Попробуйте ещё раз.", chatId);
    return true;
  }

  await supabase
    .from("telegram_link_tokens")
    .update({ used: true })
    .eq("id", linkToken.id);

  await send2FAMessage(
    "✅ Telegram успешно привязан к вашему аккаунту СнабЧат!\n\nТеперь вы будете получать коды для входа через этот чат.",
    chatId
  );

  console.log(`[Telegram 2FA Webhook] Telegram linked for invite_code_id: ${linkToken.invite_code_id}`);
  return true;
}

/**
 * POST /api/telegram/webhook-2fa — вебхук 2FA-бота (@SC2FA_Bot).
 * Обрабатывает только /start <token> для привязки Telegram.
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

  if (messageText.startsWith("/start ")) {
    const token = messageText.slice(7).trim();
    await handleStartCommand(chatId, token);
    return NextResponse.json({ ok: true });
  }

  if (messageText === "/start") {
    await send2FAMessage(
      "Этот бот используется для двухфакторной аутентификации СнабЧат.\n\nДля привязки Telegram к вашему аккаунту используйте ссылку из настроек на сайте.",
      chatId
    );
    return NextResponse.json({ ok: true });
  }

  // Все остальные сообщения игнорируем — это 2FA-бот
  return NextResponse.json({ ok: true });
}
