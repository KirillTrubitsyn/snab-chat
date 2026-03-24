import { NextRequest, NextResponse } from "next/server";
import { isAdminCode } from "@/app/lib/auth";

/**
 * GET /api/telegram/setup?code=КИРИЛЛ-АДМИН — регистрация Telegram webhook.
 * Доступно только админам. Открыть в браузере один раз после деплоя.
 */
export async function GET(req: NextRequest) {
  // Авторизация через query-параметр (для открытия в браузере)
  const code = decodeURIComponent(req.nextUrl.searchParams.get("code") ?? "");
  if (!code || !isAdminCode(code)) {
    return NextResponse.json({ error: "Добавьте ?code=ВАШ-АДМИН-КОД в URL" }, { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!botToken) {
    return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN не настроен" }, { status: 500 });
  }

  // Определяем URL webhook из текущего хоста
  const host = req.headers.get("host") ?? "www.snabchat.app";
  const protocol = host.includes("localhost") ? "http" : "https";
  const webhookUrl = `${protocol}://${host}/api/telegram/webhook`;

  const body: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ["message"],
  };
  if (webhookSecret) {
    body.secret_token = webhookSecret;
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await res.json();

  return NextResponse.json({
    webhook_url: webhookUrl,
    secret_configured: !!webhookSecret,
    telegram_response: result,
  });
}
