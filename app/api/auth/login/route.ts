import { NextRequest, NextResponse } from "next/server";
import {
  isAdminCode,
  isDocumentAdmin,
  getAdminName,
  validateInviteCode,
  consumeInviteCodeFallback,
  checkAndRegisterDevice,
} from "@/app/lib/auth";
import { loginSchema, parseBody } from "@/app/lib/validation";
import { notifyNewUser } from "@/app/lib/telegram";

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
      });
    }

    // 2. Проверка инвайт-кодов в БД
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json(
        { error: "Неверный или деактивированный инвайт-код" },
        { status: 401 }
      );
    }

    // 3. Проверка лимита устройств
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

    // 4. Уменьшаем счётчик использований
    await consumeInviteCodeFallback(invite.id);

    // 5. Уведомление при активации кода с нового устройства
    if (isNewDevice) {
      notifyNewUser(invite.name, invite.organization).catch(() => {});
    }

    return NextResponse.json({
      type: "user",
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
    });
  } catch {
    return NextResponse.json(
      { error: "Ошибка сервера" },
      { status: 500 }
    );
  }
}
