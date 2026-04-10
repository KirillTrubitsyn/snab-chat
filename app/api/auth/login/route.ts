import { NextRequest, NextResponse } from "next/server";
import {
  isAdminCode,
  isDocumentAdmin,
  isCodeDeletionAdmin,
  getAdminName,
  getAdminNumber,
  validateInviteCodeDetailed,
  checkAndRegisterDevice,
} from "@/app/lib/auth";
import { loginSchema, parseBody } from "@/app/lib/validation";
import { notifyNewUser } from "@/app/lib/telegram";
import { createServiceClient } from "@/app/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, loginSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const device_id = data.device_id;

    // 1. Проверка админ-кодов
    if (isAdminCode(upperCode)) {
      const adminName = getAdminName(upperCode)!;
      return NextResponse.json({
        type: "admin",
        adminName,
        code: upperCode,
        isDocumentAdmin: isDocumentAdmin(upperCode),
        isPrimaryAdmin: getAdminNumber(upperCode) === 1,
        canDeleteCodes: isCodeDeletionAdmin(upperCode),
      });
    }

    // 2. Проверка инвайт-кодов в БД
    const result = await validateInviteCodeDetailed(upperCode);
    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: "Неверный инвайт-код",
        inactive: "Этот инвайт-код деактивирован. Обратитесь к администратору.",
        uses_exhausted: "Лимит использований этого инвайт-кода исчерпан. Обратитесь к администратору.",
      };
      return NextResponse.json(
        { error: messages[result.reason] },
        { status: 401 }
      );
    }
    const invite = result.invite;

    // 3. Получить данные о 2FA и пароле
    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash, telegram_chat_id, phone_number, totp_secret")
      .eq("id", invite.id)
      .single();

    const hasPassword = !!codeData?.password_hash;
    const twoFactorMethods: string[] = [];
    if (codeData?.telegram_chat_id) twoFactorMethods.push("telegram");
    if (codeData?.phone_number) twoFactorMethods.push("sms");
    if (codeData?.totp_secret) twoFactorMethods.push("totp");

    // 4. Проверка лимита устройств
    let isNewDevice = false;
    if (device_id) {
      const userAgent = req.headers.get("user-agent") || "";
      const { error: deviceError, isNewDevice: newDevice } = await checkAndRegisterDevice(
        invite.id,
        device_id,
        invite.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return NextResponse.json(
          { error: deviceError },
          { status: 403 }
        );
      }
      isNewDevice = newDevice;
    }

    // 5. НЕ расходуем uses_remaining здесь — это делает set-password после установки пароля.
    // Если расходовать на этапе login, то set-password и 2FA-роуты не смогут пройти валидацию.

    // 6. Уведомление при активации кода с нового устройства
    if (isNewDevice) {
      notifyNewUser(invite.name, invite.organization).catch(() => {});
    }

    return NextResponse.json({
      type: "user",
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      hasPassword,
      twoFactorMethods,
    });
  } catch {
    return NextResponse.json(
      { error: "Ошибка сервера" },
      { status: 500 }
    );
  }
}
