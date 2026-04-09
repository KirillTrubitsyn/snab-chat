import { NextRequest, NextResponse } from "next/server";
import {
  validateInviteCode,
  consumeInviteCodeFallback,
  checkAndRegisterDevice,
} from "@/app/lib/auth";
import { verifyPasswordSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import { notifyNewUser } from "@/app/lib/telegram";
import bcrypt from "bcryptjs";

/**
 * POST /api/auth/verify-password — проверка пароля при входе.
 * Body: { code, password, device_id? }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, verifyPasswordSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    // Получить хеш пароля и 2FA данные
    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash, telegram_chat_id, phone_number, totp_secret")
      .eq("id", invite.id)
      .single();

    if (!codeData?.password_hash) {
      return NextResponse.json({ error: "Пароль не установлен" }, { status: 400 });
    }

    // Проверить пароль
    const valid = await bcrypt.compare(data.password, codeData.password_hash);
    if (!valid) {
      return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
    }

    // Проверка лимита устройств
    let isNewDevice = false;
    if (data.device_id) {
      const userAgent = req.headers.get("user-agent") || "";
      const { error: deviceError, isNewDevice: newDevice } = await checkAndRegisterDevice(
        invite.id,
        data.device_id,
        invite.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return NextResponse.json({ error: deviceError }, { status: 403 });
      }
      isNewDevice = newDevice;
    }

    await consumeInviteCodeFallback(invite.id);

    if (isNewDevice) {
      notifyNewUser(invite.name, invite.organization).catch(() => {});
    }

    const twoFactorMethods: string[] = [];
    if (codeData.telegram_chat_id) twoFactorMethods.push("telegram");
    if (codeData.phone_number) twoFactorMethods.push("sms");
    if (codeData.totp_secret) twoFactorMethods.push("totp");

    return NextResponse.json({
      success: true,
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      twoFactorMethods,
    });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
