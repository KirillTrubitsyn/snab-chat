import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  isAdminCode,
  isDocumentAdmin,
  getAdminName,
  validateInviteCode,
  checkAndRegisterDevice,
} from "@/app/lib/auth";
import { loginSchema, parseBody } from "@/app/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, loginSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const device_id = data.device_id;
    const password = data.password;

    // 1. Проверка админ-кодов (без пароля, без 2FA)
    if (isAdminCode(upperCode)) {
      const adminName = getAdminName(upperCode)!;
      return NextResponse.json({
        type: "admin",
        adminName,
        code: upperCode,
        isDocumentAdmin: isDocumentAdmin(upperCode),
      });
    }

    // 2. Проверка инвайт-кода в БД
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json(
        { error: "Неверный или деактивированный инвайт-код" },
        { status: 401 }
      );
    }

    // 3. Первый вход: пароль не установлен → нужно создать
    if (invite.password_hash === null) {
      return NextResponse.json({ needsPasswordSetup: true });
    }

    // 4. Пароль не передан → попросить ввести
    if (!password) {
      return NextResponse.json({ needsPassword: true });
    }

    // 5. Проверка пароля
    const passwordOk = await bcrypt.compare(password, invite.password_hash);
    if (!passwordOk) {
      return NextResponse.json(
        { error: "Неверный пароль" },
        { status: 401 }
      );
    }

    // 6. Определить метод 2FA (приоритет: Telegram > TOTP > SMS)
    if (invite.telegram_chat_id) {
      return NextResponse.json({ needs2FA: true, method: "telegram" });
    }
    if (invite.totp_secret) {
      return NextResponse.json({ needs2FA: true, method: "totp" });
    }
    if (invite.phone_number) {
      return NextResponse.json({ needs2FA: true, method: "sms" });
    }

    // 7. Регистрация устройства и успешный вход
    if (device_id) {
      const userAgent = req.headers.get("user-agent") || "";
      const deviceError = await checkAndRegisterDevice(
        invite.id,
        device_id,
        invite.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return NextResponse.json({ error: deviceError }, { status: 403 });
      }
    }

    // 2FA не настроена — рекомендуем при каждом входе
    return NextResponse.json({
      type: "user",
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      suggest2FA: true,
    });
  } catch {
    return NextResponse.json(
      { error: "Ошибка сервера" },
      { status: 500 }
    );
  }
}
