import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";

/**
 * POST /api/telegram/setup — регистрация Telegram webhook.
 * Доступно только админам. Админ-код передаётся через заголовок X-Admin-Code.
 *
 * curl -X POST https://snabchat.app/api/telegram/setup \
 *   -H "X-Admin-Code: ВАШ-АДМИН-КОД"
 */
export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

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
