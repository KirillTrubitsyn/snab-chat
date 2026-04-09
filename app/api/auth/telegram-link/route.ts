import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { telegramLinkSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import { randomUUID } from "crypto";

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "";

/**
 * POST /api/auth/telegram-link — генерация deep link для привязки Telegram.
 * Body: { code }
 * Response: { token, botUrl }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, telegramLinkSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    if (!BOT_USERNAME) {
      return NextResponse.json(
        { error: "TELEGRAM_BOT_USERNAME не настроен" },
        { status: 500 }
      );
    }

    const supabase = createServiceClient();

    // Инвалидировать старые неиспользованные токены
    await supabase
      .from("telegram_link_tokens")
      .update({ used: true })
      .eq("invite_code_id", invite.id)
      .eq("used", false);

    // Создать новый токен (10 минут)
    const token = randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from("telegram_link_tokens")
      .insert({
        invite_code_id: invite.id,
        token,
        expires_at: expiresAt,
      });

    if (insertError) {
      console.error("[telegram-link] DB error:", insertError.message);
      return NextResponse.json({ error: "Ошибка создания токена" }, { status: 500 });
    }

    const botUrl = `https://t.me/${BOT_USERNAME}?start=${token}`;

    return NextResponse.json({ token, botUrl });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
