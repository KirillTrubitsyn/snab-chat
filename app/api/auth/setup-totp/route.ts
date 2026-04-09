import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { generateTOTPSecret, generateTOTPUrl } from "@/app/lib/otp";

/**
 * GET /api/auth/setup-totp?code=XXX — генерация TOTP-секрета и QR URL.
 * Секрет НЕ сохраняется в БД до верификации.
 */
export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    if (!code) {
      return NextResponse.json({ error: "Код не указан" }, { status: 400 });
    }

    const upperCode = code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    const secret = generateTOTPSecret();
    const otpauthUrl = generateTOTPUrl(secret, invite.name);

    return NextResponse.json({ secret, otpauthUrl });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
