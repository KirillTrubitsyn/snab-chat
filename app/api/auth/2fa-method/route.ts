import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { twoFactorMethodSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";

/**
 * DELETE /api/auth/2fa-method — удалить метод 2FA.
 * Body: { code, method: "telegram" | "sms" | "totp" }
 */
export async function DELETE(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, twoFactorMethodSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    const supabase = createServiceClient();
    const fieldMap: Record<string, string> = {
      telegram: "telegram_chat_id",
      sms: "phone_number",
      totp: "totp_secret",
    };

    const field = fieldMap[data.method];
    if (!field) {
      return NextResponse.json({ error: "Неизвестный метод" }, { status: 400 });
    }

    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ [field]: null })
      .eq("id", invite.id);

    if (updateError) {
      console.error("[2fa-method] DB error:", updateError.message);
      return NextResponse.json({ error: "Ошибка удаления" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
