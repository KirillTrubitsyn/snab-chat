import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { setupSmsSchema, parseBody } from "@/app/lib/validation";
import { generateOTP, saveOTP, checkOTPRateLimit } from "@/app/lib/otp";
import { sendSMS } from "@/app/lib/sms";

/**
 * POST /api/auth/setup-sms — отправка OTP для привязки номера телефона.
 * Body: { code, phone }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, setupSmsSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    // Rate limit
    const withinLimit = await checkOTPRateLimit(invite.id, "sms");
    if (!withinLimit) {
      return NextResponse.json(
        { error: "Слишком много попыток. Подождите немного." },
        { status: 429 }
      );
    }

    const otp = generateOTP();
    await saveOTP(invite.id, otp, "sms");

    const sent = await sendSMS(
      data.phone,
      `СнабЧат: ваш код подтверждения ${otp}. Действителен 5 минут.`
    );

    if (!sent) {
      return NextResponse.json({ error: "Ошибка отправки SMS" }, { status: 500 });
    }

    return NextResponse.json({ sent: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
