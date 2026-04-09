import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { verifySetupOtpSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import { verifyOTP, verifyTOTP } from "@/app/lib/otp";

/**
 * POST /api/auth/verify-setup-otp — проверка OTP при настройке 2FA.
 * Body: { code, otp, method: "telegram"|"sms"|"totp", phone?, totpSecret? }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, verifySetupOtpSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    const supabase = createServiceClient();

    if (data.method === "totp") {
      // Проверить TOTP по переданному секрету
      if (!data.totpSecret) {
        return NextResponse.json({ error: "TOTP-секрет не указан" }, { status: 400 });
      }

      const valid = verifyTOTP(data.otp, data.totpSecret);
      if (!valid) {
        return NextResponse.json({ error: "Неверный код" }, { status: 401 });
      }

      // Сохранить секрет в БД
      const { error: updateError } = await supabase
        .from("invite_codes")
        .update({ totp_secret: data.totpSecret })
        .eq("id", invite.id);

      if (updateError) {
        return NextResponse.json({ error: "Ошибка сохранения" }, { status: 500 });
      }
    } else if (data.method === "sms") {
      if (!data.phone) {
        return NextResponse.json({ error: "Номер телефона не указан" }, { status: 400 });
      }

      const valid = await verifyOTP(invite.id, data.otp, "sms");
      if (!valid) {
        return NextResponse.json({ error: "Неверный код" }, { status: 401 });
      }

      // Сохранить номер телефона
      const { error: updateError } = await supabase
        .from("invite_codes")
        .update({ phone_number: data.phone })
        .eq("id", invite.id);

      if (updateError) {
        return NextResponse.json({ error: "Ошибка сохранения" }, { status: 500 });
      }
    } else if (data.method === "telegram") {
      const valid = await verifyOTP(invite.id, data.otp, "telegram");
      if (!valid) {
        return NextResponse.json({ error: "Неверный код" }, { status: 401 });
      }
      // telegram_chat_id уже сохранён через webhook
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
