import { NextRequest, NextResponse } from "next/server";
import { generateSecret, generateURI, verifySync } from "otplib";
import { validateInviteCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { setupTotpConfirmSchema, parseBody } from "@/app/lib/validation";

// GET /api/auth/setup-totp?code=XXX — сгенерировать секрет и otpauth URL
export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    if (!code) return NextResponse.json({ error: "code обязателен" }, { status: 400 });

    const invite = await validateInviteCode(code.toUpperCase());
    if (!invite) {
      return NextResponse.json({ error: "Неверный или деактивированный инвайт-код" }, { status: 401 });
    }

    if (invite.totp_secret) {
      return NextResponse.json({ error: "TOTP уже настроен" }, { status: 400 });
    }

    const secret = generateSecret();
    const otpauthUrl = generateURI({ secret, label: invite.name, issuer: "СнабЧат" });

    return NextResponse.json({ secret, otpauthUrl });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

// POST /api/auth/setup-totp — подтвердить TOTP и сохранить секрет
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, setupTotpConfirmSchema);
    if (error) return error;

    const invite = await validateInviteCode(data.code.toUpperCase());
    if (!invite) {
      return NextResponse.json({ error: "Неверный или деактивированный инвайт-код" }, { status: 401 });
    }

    if (invite.totp_secret) {
      return NextResponse.json({ error: "TOTP уже настроен" }, { status: 400 });
    }

    const result = verifySync({ secret: data.secret, token: data.otp });
    if (!result || (typeof result === "object" && !result.valid)) {
      return NextResponse.json({ error: "Неверный код — попробуйте ещё раз" }, { status: 401 });
    }

    const supabase = createServiceClient();
    await supabase.from("invite_codes").update({ totp_secret: data.secret }).eq("id", invite.id);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
