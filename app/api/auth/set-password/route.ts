import { NextRequest, NextResponse } from "next/server";
import { setPasswordSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import bcrypt from "bcryptjs";

/**
 * POST /api/auth/set-password — установка пароля при первом входе.
 * Body: { code, password }
 *
 * Примечание: на этом этапе uses_remaining уже = 0 (израсходован при login),
 * поэтому НЕ используем validateInviteCode (она отклонит код).
 * Вместо этого ищем код напрямую и проверяем только is_active.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, setPasswordSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const supabase = createServiceClient();

    // Найти код напрямую (uses_remaining уже 0 после login, это нормально)
    const { data: invite, error: dbError } = await supabase
      .from("invite_codes")
      .select("id, password_hash, is_active")
      .eq("code", upperCode)
      .single();

    if (dbError || !invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    if (!invite.is_active) {
      return NextResponse.json({ error: "Этот инвайт-код деактивирован" }, { status: 401 });
    }

    // Проверить, что пароль ещё не установлен
    if (invite.password_hash) {
      return NextResponse.json({ error: "Пароль уже установлен" }, { status: 400 });
    }

    // Хешировать пароль
    // НЕ трогаем код и uses_remaining — инвайт-код остаётся валидным
    // для последующих шагов (настройка 2FA). Пароль — достаточная защита.
    const hash = await bcrypt.hash(data.password, 12);
    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ password_hash: hash })
      .eq("id", invite.id);

    if (updateError) {
      console.error("[set-password] DB error:", updateError.message);
      return NextResponse.json({ error: "Ошибка сохранения" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
