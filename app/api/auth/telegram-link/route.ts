import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { telegramLinkSchema, parseBody } from "@/app/lib/validation";
import { generateOTP, saveOTP } from "@/app/lib/otp";

const BOT_USERNAME = process.env.TELEGRAM_2FA_BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || "";

/**
 * POST /api/auth/telegram-link — генерация OTP для привязки Telegram.
 * Пользователь получает код, отправляет его боту, бот привязывает аккаунт.
 * Body: { code }
 * Response: { otp, botUrl }
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

    const otp = generateOTP();
    await saveOTP(invite.id, otp, "telegram", 10); // 10 minutes

    const botUrl = `https://t.me/${BOT_USERNAME}`;

    return NextResponse.json({ otp, botUrl });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
