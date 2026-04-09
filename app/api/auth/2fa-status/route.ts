import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";

/**
 * GET /api/auth/2fa-status?code=XXX — получить статус методов 2FA.
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

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("telegram_chat_id, phone_number, totp_secret")
      .eq("id", invite.id)
      .single();

    return NextResponse.json({
      telegram: !!codeData?.telegram_chat_id,
      sms: !!codeData?.phone_number,
      totp: !!codeData?.totp_secret,
      phone: codeData?.phone_number
        ? codeData.phone_number.replace(/^(\+7)\d{7}(\d{3})$/, "$1***$2")
        : null,
    });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
