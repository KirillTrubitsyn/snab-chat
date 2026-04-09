import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { sendOtpSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import { generateOTP, saveOTP, checkOTPRateLimit } from "@/app/lib/otp";
import { sendTelegramMessage } from "@/app/lib/telegram";
import { sendSMS } from "@/app/lib/sms";

/**
 * POST /api/auth/send-otp — отправка OTP при входе (Telegram или SMS).
 * Body: { code, method: "telegram" | "sms" }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, sendOtpSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    // Получить данные 2FA
    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("telegram_chat_id, phone_number")
      .eq("id", invite.id)
      .single();

    if (!codeData) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    // Rate limit
    const withinLimit = await checkOTPRateLimit(invite.id, `login_${data.method}`);
    if (!withinLimit) {
      return NextResponse.json(
        { error: "Слишком много попыток. Подождите немного." },
        { status: 429 }
      );
    }

    const otp = generateOTP();
    const dbMethod = `login_${data.method}`;

    if (data.method === "telegram") {
      if (!codeData.telegram_chat_id) {
        return NextResponse.json({ error: "Telegram не привязан" }, { status: 400 });
      }
      await saveOTP(invite.id, otp, dbMethod);
      const sent = await sendTelegramMessage(
        `🔐 Ваш код для входа в СнабЧат: <b>${otp}</b>\n\nКод действителен 5 минут.`,
        codeData.telegram_chat_id
      );
      if (!sent) {
        return NextResponse.json({ error: "Ошибка отправки в Telegram" }, { status: 500 });
      }
    } else if (data.method === "sms") {
      if (!codeData.phone_number) {
        return NextResponse.json({ error: "Номер телефона не привязан" }, { status: 400 });
      }
      await saveOTP(invite.id, otp, dbMethod);
      const sent = await sendSMS(
        codeData.phone_number,
        `СнабЧат: ваш код для входа ${otp}. Действителен 5 минут.`
      );
      if (!sent) {
        return NextResponse.json({ error: "Ошибка отправки SMS" }, { status: 500 });
      }
    }

    return NextResponse.json({ sent: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
