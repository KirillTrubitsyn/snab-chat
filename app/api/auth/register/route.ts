import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { checkAndRegisterDevice } from "@/app/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { password, name, organization, device_id } = await req.json();

    if (!password || typeof password !== "string" || password.trim().length < 8) {
      return NextResponse.json(
        { error: "Пароль должен быть не менее 8 символов" },
        { status: 400 }
      );
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json(
        { error: "Введите ФИО" },
        { status: 400 }
      );
    }
    if (!organization || typeof organization !== "string" || !organization.trim()) {
      return NextResponse.json(
        { error: "Введите организацию" },
        { status: 400 }
      );
    }

    const code = password.trim().toUpperCase();
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
        name: name.trim(),
        organization: organization.trim(),
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
