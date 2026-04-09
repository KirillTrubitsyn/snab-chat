import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { sendOtpSchema, parseBody } from "@/app/lib/validation";

async function sendSmscSms(phone: string, message: string): Promise<boolean> {
  const login = process.env.SMSC_LOGIN;
  const password = process.env.SMSC_PASSWORD;
  if (!login || !password) {
    console.error("[SMS] SMSC_LOGIN / SMSC_PASSWORD not configured");
    return false;
  }
  try {
    const params = new URLSearchParams({
      login,
      psw: password,
      phones: phone,
      mes: message,
      fmt: "3", // JSON response
      charset: "utf-8",
    });
    const res = await fetch(`https://smsc.ru/sys/send.php?${params.toString()}`);
    const json = await res.json();
    if (json.error_code) {
      console.error(`[SMS] SMSC error ${json.error_code}: ${json.error}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[SMS] Network error:", e);
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, sendOtpSchema);
    if (error) return error;

    const invite = await validateInviteCode(data.code.toUpperCase());
    if (!invite) {
      return NextResponse.json({ error: "Неверный или деактивированный инвайт-код" }, { status: 401 });
    }

    if (!invite.phone_number) {
      return NextResponse.json({ error: "Номер телефона не настроен для этого аккаунта" }, { status: 400 });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const supabase = createServiceClient();
    await supabase
      .from("invite_codes")
      .update({ otp_code: otp, otp_expires_at: expiresAt })
      .eq("id", invite.id);

    const sent = await sendSmscSms(
      invite.phone_number,
      `СнабЧат: ваш код входа ${otp}. Действителен 5 минут.`
    );

    if (!sent) {
      return NextResponse.json({ error: "Ошибка отправки СМС. Попробуйте позже." }, { status: 502 });
    }

    return NextResponse.json({ sent: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
