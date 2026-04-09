import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { validateInviteCode, consumeInviteCodeFallback, checkAndRegisterDevice } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { setPasswordSchema, parseBody } from "@/app/lib/validation";

function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "Пароль должен содержать не менее 8 символов";
  if (!/[A-ZА-ЯЁ]/.test(password)) return "Пароль должен содержать хотя бы одну заглавную букву";
  if (!/[a-zа-яё]/.test(password)) return "Пароль должен содержать хотя бы одну строчную букву";
  if (!/\d/.test(password)) return "Пароль должен содержать хотя бы одну цифру";
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, setPasswordSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();

    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный или деактивированный инвайт-код" }, { status: 401 });
    }

    if (invite.password_hash !== null) {
      return NextResponse.json({ error: "Пароль уже установлен. Войдите с паролем." }, { status: 400 });
    }

    const strengthError = validatePasswordStrength(data.password);
    if (strengthError) {
      return NextResponse.json({ error: strengthError }, { status: 400 });
    }

    const hash = await bcrypt.hash(data.password, 10);

    const supabase = createServiceClient();
    await supabase.from("invite_codes").update({ password_hash: hash }).eq("id", invite.id);

    // Одноразовое использование инвайт-кода
    await consumeInviteCodeFallback(invite.id);

    // Регистрация устройства
    if (data.device_id) {
      const userAgent = req.headers.get("user-agent") || "";
      const deviceError = await checkAndRegisterDevice(
        invite.id,
        data.device_id,
        invite.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return NextResponse.json({ error: deviceError }, { status: 403 });
      }
    }

    return NextResponse.json({
      type: "user",
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      suggest2FA: true,
    });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
