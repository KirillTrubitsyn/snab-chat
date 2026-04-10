import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { setPasswordSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import bcrypt from "bcryptjs";

/**
 * POST /api/auth/set-password — установка пароля при первом входе.
 * Body: { code, password }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, setPasswordSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    // Проверить, что пароль ещё не установлен
    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash")
      .eq("id", invite.id)
      .single();

    if (codeData?.password_hash) {
      return NextResponse.json({ error: "Пароль уже установлен" }, { status: 400 });
    }

    // Хешировать пароль и уничтожить инвайт-код (заменить на случайный)
    const hash = await bcrypt.hash(data.password, 12);
    const deadCode = `USED-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ password_hash: hash, uses_remaining: 0, code: deadCode })
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
