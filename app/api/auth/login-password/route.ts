import { NextRequest, NextResponse } from "next/server";
import { checkAndRegisterDevice } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { notifyNewUser } from "@/app/lib/telegram";
import bcrypt from "bcryptjs";

/**
 * POST /api/auth/login-password — вход только по паролю (без инвайт-кода).
 * Перебирает все зарегистрированные пароли и находит пользователя.
 * Body: { password, device_id? }
 */
export async function POST(req: NextRequest) {
  try {
    const { password, device_id } = await req.json();

    if (!password || typeof password !== "string") {
      return NextResponse.json({ error: "Введите пароль" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data: users, error: dbError } = await supabase
      .from("invite_codes")
      .select("id, code, name, organization, password_hash, device_limit, telegram_chat_id, phone_number, totp_secret")
      .not("password_hash", "is", null)
      .eq("is_active", true);

    if (dbError || !users || users.length === 0) {
      return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
    }

    // Перебираем всех пользователей с паролем
    let matched: typeof users[0] | null = null;
    for (const user of users) {
      if (!user.password_hash) continue;
      const valid = await bcrypt.compare(password, user.password_hash);
      if (valid) {
        matched = user;
        break;
      }
    }

    if (!matched) {
      return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
    }

    // Проверка лимита устройств
    if (device_id) {
      const userAgent = req.headers.get("user-agent") || "";
      const { error: deviceError, isNewDevice } = await checkAndRegisterDevice(
        matched.id,
        device_id,
        matched.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return NextResponse.json({ error: deviceError }, { status: 403 });
      }
      if (isNewDevice) {
        notifyNewUser(matched.name, matched.organization).catch(() => {});
      }
    }

    const twoFactorMethods: string[] = [];
    if (matched.telegram_chat_id) twoFactorMethods.push("telegram");
    if (matched.phone_number) twoFactorMethods.push("sms");
    if (matched.totp_secret) twoFactorMethods.push("totp");

    return NextResponse.json({
      success: true,
      inviteCodeId: matched.id,
      name: matched.name,
      code: matched.code,
      twoFactorMethods,
    });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
