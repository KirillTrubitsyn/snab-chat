import { NextRequest, NextResponse } from "next/server";
import {
  isAdminCode,
  getAdminName,
  validateInviteCode,
  consumeInviteCodeFallback,
} from "@/app/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json();

    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "Введите инвайт-код" },
        { status: 400 }
      );
    }

    const upperCode = code.toUpperCase();

    // 1. Проверка админ-кодов
    if (isAdminCode(upperCode)) {
      const adminName = getAdminName(upperCode)!;
      return NextResponse.json({
        type: "admin",
        adminName,
        code: upperCode,
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

    // 3. Уменьшаем счётчик использований
    await consumeInviteCodeFallback(invite.id);

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
