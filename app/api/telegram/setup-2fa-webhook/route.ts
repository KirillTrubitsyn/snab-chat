import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/telegram/setup-2fa-webhook
 * Временный эндпоинт для перерегистрации вебхука 2FA-бота.
 * Открыть в браузере: https://www.snabchat.app/api/telegram/setup-2fa-webhook
 * УДАЛИТЬ ПОСЛЕ ИСПОЛЬЗОВАНИЯ!
 */
export async function GET(req: NextRequest) {
  const bot2FAToken = process.env.TELEGRAM_2FA_BOT_TOKEN;
  const webhook2FASecret = process.env.TELEGRAM_2FA_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!bot2FAToken) {
    return NextResponse.json({ error: "TELEGRAM_2FA_BOT_TOKEN не настроен" }, { status: 500 });
  }

  const host = req.headers.get("host") ?? "www.snabchat.app";
  const protocol = host.includes("localhost") ? "http" : "https";
  const webhook2FAUrl = `${protocol}://${host}/api/telegram/webhook-2fa`;

  const body: Record<string, unknown> = {
    url: webhook2FAUrl,
    allowed_updates: ["message", "callback_query"],
  };
  if (webhook2FASecret) {
    body.secret_token = webhook2FASecret;
  }

  const res = await fetch(`https://api.telegram.org/bot${bot2FAToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json();

  return NextResponse.json({
    webhook_url: webhook2FAUrl,
    allowed_updates: ["message", "callback_query"],
    secret_configured: !!webhook2FASecret,
    telegram_response: result,
    message: "Вебхук 2FA-бота перерегистрирован. УДАЛИТЕ этот файл после использования!",
  });
}
