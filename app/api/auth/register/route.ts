import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { checkAndRegisterDevice } from "@/app/lib/auth";
import { registerSchema, parseBody } from "@/app/lib/validation";
import { notifyNewUser } from "@/app/lib/telegram";

export async function POST(req: NextRequest) {
  // Self-registration is paused until further notice.
  // Only administrators can create invite codes via the admin panel.
  return NextResponse.json(
    { error: "Регистрация временно приостановлена. Обратитесь к администратору для получения кода доступа." },
    { status: 403 }
  );

  try {
    const raw = await req.json();
    const { data: body, error: valError } = parseBody(raw, registerSchema);
    if (valError) return valError;

    const code = body.password.toUpperCase();
    const { name, organization, device_id } = body;
    const supabase = createServiceClient();

    // Check if this code already exists
    const { data: existing } = await supabase
      .from("invite_codes")
      .select("id, name")
      .eq("code", code)
      .eq("is_active", true)
      .single();

    if (existing) {
      // Code already exists — log in instead
      if (device_id) {
        const userAgent = req.headers.get("user-agent") || "";
        const deviceError = await checkAndRegisterDevice(
          existing.id,
          device_id,
          2,
          userAgent
        );
        if (deviceError) {
          return NextResponse.json({ error: deviceError }, { status: 403 });
        }
      }

      return NextResponse.json({
        type: "user",
        inviteCodeId: existing.id,
        name: existing.name,
        code,
      });
    }

    // Create new invite code entry for this user
    const { data: newCode, error: insertError } = await supabase
      .from("invite_codes")
      .insert({
        code,
        name,
        organization,
        uses_remaining: null,
        device_limit: 2,
        is_active: true,
      })
      .select("id, name, code")
      .single();

    if (insertError || !newCode) {
      console.error("Register insert error:", insertError);
      return NextResponse.json(
        { error: "Ошибка создания учётной записи" },
        { status: 500 }
      );
    }

    // Register device
    if (device_id) {
      const userAgent = req.headers.get("user-agent") || "";
      await checkAndRegisterDevice(newCode.id, device_id, 2, userAgent);
    }

    // Notify admins about new registration (fire-and-forget)
    notifyNewUser(name, organization).catch(() => {});

    return NextResponse.json({
      type: "user",
      inviteCodeId: newCode.id,
      name: newCode.name,
      code: newCode.code,
    });
  } catch (err) {
    console.error("Register error:", err);
    return NextResponse.json(
      { error: "Ошибка сервера" },
      { status: 500 }
    );
  }
}
