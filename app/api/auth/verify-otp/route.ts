import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { verifyOtpSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import { verifyOTP, verifyTOTP } from "@/app/lib/otp";
import { logSecurityEvent } from "@/app/lib/security-log";

/**
 * POST /api/auth/verify-otp — проверка OTP при входе.
 * Body: { code, otp, method: "telegram" | "sms" | "totp" }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, verifyOtpSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    let valid = false;

    if (data.method === "totp") {
      // Проверить TOTP через секрет из БД
      const supabase = createServiceClient();
      const { data: codeData } = await supabase
        .from("invite_codes")
        .select("totp_secret")
        .eq("id", invite.id)
        .single();

      if (!codeData?.totp_secret) {
        return NextResponse.json({ error: "TOTP не настроен" }, { status: 400 });
      }

      valid = verifyTOTP(data.otp, codeData.totp_secret);
    } else {
      // Проверить OTP из БД (telegram/sms)
      const dbMethod = `login_${data.method}`;
      valid = await verifyOTP(invite.id, data.otp, dbMethod);
    }

    if (!valid) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
      logSecurityEvent("auth.otp_fail", {
        ip,
        userAgent: req.headers.get("user-agent"),
        inviteCodeId: invite.id,
        details: { method: data.method, endpoint: "/api/auth/verify-otp" },
      });
      return NextResponse.json({ error: "Неверный код" }, { status: 401 });
    }

    return NextResponse.json({
      success: true,
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
    });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
