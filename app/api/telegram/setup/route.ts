import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";

/**
 * POST /api/telegram/setup — регистрация Telegram webhook(ов).
 * Регистрирует основной бот + 2FA-бот (если настроен).
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
  const bot2FAToken = process.env.TELEGRAM_2FA_BOT_TOKEN;
  const webhook2FASecret = process.env.TELEGRAM_2FA_WEBHOOK_SECRET || webhookSecret;

  if (!botToken) {
    return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN не настроен" }, { status: 500 });
  }

  const host = req.headers.get("host") ?? "www.snabchat.app";
  const protocol = host.includes("localhost") ? "http" : "https";

  // ── Основной бот (поддержка + уведомления) ──
  const webhookUrl = `${protocol}://${host}/api/telegram/webhook`;
  const body: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
  };
  if (webhookSecret) {
    body.secret_token = webhookSecret;
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const mainResult = await res.json();

  // ── 2FA бот (если настроен) ──
  let twoFAResult = null;
  let webhook2FAUrl = "";
  if (bot2FAToken) {
    webhook2FAUrl = `${protocol}://${host}/api/telegram/webhook-2fa`;
    const body2FA: Record<string, unknown> = {
      url: webhook2FAUrl,
      allowed_updates: ["message", "callback_query"],
    };
    if (webhook2FASecret) {
      body2FA.secret_token = webhook2FASecret;
    }

    const res2FA = await fetch(`https://api.telegram.org/bot${bot2FAToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body2FA),
    });
    twoFAResult = await res2FA.json();
  }

  return NextResponse.json({
    main_bot: {
      webhook_url: webhookUrl,
      secret_configured: !!webhookSecret,
      telegram_response: mainResult,
    },
    two_fa_bot: bot2FAToken
      ? {
          webhook_url: webhook2FAUrl,
          secret_configured: !!webhook2FASecret,
          telegram_response: twoFAResult,
        }
      : { status: "not_configured" },
  });
}
