import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { sendTelegramMessage } from "@/app/lib/telegram";
import { sendOtpSchema, parseBody } from "@/app/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, sendOtpSchema);
    if (error) return error;

    const invite = await validateInviteCode(data.code.toUpperCase());
    if (!invite) {
      return NextResponse.json({ error: "Неверный или деактивированный инвайт-код" }, { status: 401 });
    }

    if (!invite.telegram_chat_id) {
      return NextResponse.json({ error: "Telegram не настроен для этого аккаунта" }, { status: 400 });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const supabase = createServiceClient();
    await supabase
      .from("invite_codes")
      .update({ otp_code: otp, otp_expires_at: expiresAt })
      .eq("id", invite.id);

    await sendTelegramMessage(
      `🔐 Ваш код входа в <b>СнабЧат</b>: <b>${otp}</b>\n\nДействителен 5 минут. Никому не сообщайте этот код.`,
      invite.telegram_chat_id
    );

    return NextResponse.json({ sent: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
