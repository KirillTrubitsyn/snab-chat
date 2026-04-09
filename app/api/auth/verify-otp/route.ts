import { NextRequest, NextResponse } from "next/server";
import { verifySync } from "otplib";
import { validateInviteCode, checkAndRegisterDevice } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { verifyOtpSchema, parseBody } from "@/app/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, verifyOtpSchema);
    if (error) return error;

    const invite = await validateInviteCode(data.code.toUpperCase());
    if (!invite) {
      return NextResponse.json({ error: "Неверный или деактивированный инвайт-код" }, { status: 401 });
    }

    const supabase = createServiceClient();

    // Определить метод и верифицировать (приоритет: Telegram > TOTP > SMS)
    if (invite.totp_secret) {
      const result = verifySync({ secret: invite.totp_secret, token: data.otp });
      if (!result || (typeof result === "object" && !result.valid)) {
        return NextResponse.json({ error: "Неверный код. Проверьте время на устройстве." }, { status: 401 });
      }
    } else if (invite.telegram_chat_id || invite.phone_number) {
      if (!invite.otp_code) {
        return NextResponse.json({ error: "Код не был отправлен. Запросите новый." }, { status: 400 });
      }
      if (!invite.otp_expires_at || new Date() > new Date(invite.otp_expires_at)) {
        return NextResponse.json({ error: "Код истёк. Запросите новый." }, { status: 401 });
      }
      if (invite.otp_code !== data.otp) {
        return NextResponse.json({ error: "Неверный код" }, { status: 401 });
      }
      // Очищаем использованный OTP
      await supabase
        .from("invite_codes")
        .update({ otp_code: null, otp_expires_at: null })
        .eq("id", invite.id);
    } else {
      return NextResponse.json({ error: "2FA не настроена для этого аккаунта" }, { status: 400 });
    }

    // Регистрация устройства
    if (data.device_id) {
      const userAgent = req.headers.get("user-agent") || "";
      const deviceError = await checkAndRegisterDevice(
        invite.id,
        data.device_id,
        invite.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return NextResponse.json({ error: deviceError }, { status: 403 });
      }
    }

    return NextResponse.json({
      type: "user",
      inviteCodeId: invite.id,
      name: invite.name,
      code: data.code.toUpperCase(),
    });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
