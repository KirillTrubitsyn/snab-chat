import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { changePasswordSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import bcrypt from "bcryptjs";

/**
 * POST /api/auth/change-password — смена пароля.
 * Body: { code, oldPassword, newPassword }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, changePasswordSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash")
      .eq("id", invite.id)
      .single();

    if (!codeData?.password_hash) {
      return NextResponse.json({ error: "Пароль не установлен" }, { status: 400 });
    }

    // Проверить старый пароль
    const valid = await bcrypt.compare(data.oldPassword, codeData.password_hash);
    if (!valid) {
      return NextResponse.json({ error: "Неверный текущий пароль" }, { status: 401 });
    }

    // Установить новый
    const hash = await bcrypt.hash(data.newPassword, 12);
    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ password_hash: hash })
      .eq("id", invite.id);

    if (updateError) {
      return NextResponse.json({ error: "Ошибка сохранения" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
