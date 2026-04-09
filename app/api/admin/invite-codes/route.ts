import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin, isCodeDeletionAdmin } from "@/app/lib/auth";
import { logAuditEvent } from "@/app/lib/audit-log";

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();

  // Получаем все инвайт-коды со статистикой
  const { data: codes, error } = await supabase
    .from("invite_codes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  // Получаем статистику по диалогам для каждого кода
  const { data: convStats } = await supabase
    .from("conversations")
    .select("invite_code_id");

  // Подсчёт диалогов по коду
  const convCounts: Record<string, number> = {};
  (convStats || []).forEach((c) => {
    if (c.invite_code_id) {
      convCounts[c.invite_code_id] = (convCounts[c.invite_code_id] || 0) + 1;
    }
  });

  // Получаем статистику по устройствам для каждого кода
  const { data: deviceStats } = await supabase
    .from("devices")
    .select("invite_code_id");

  const deviceCounts: Record<string, number> = {};
  (deviceStats || []).forEach((d) => {
    if (d.invite_code_id) {
      deviceCounts[d.invite_code_id] = (deviceCounts[d.invite_code_id] || 0) + 1;
    }
  });

  const result = (codes || []).map((code) => ({
    ...code,
    conversation_count: convCounts[code.id] || 0,
    device_count: deviceCounts[code.id] || 0,
    has_password: !!code.password_hash,
    has_telegram: !!code.telegram_chat_id,
    has_sms: !!code.phone_number,
    has_totp: !!code.totp_secret,
    // Не возвращать секретные поля
    password_hash: undefined,
    telegram_chat_id: undefined,
    phone_number: undefined,
    totp_secret: undefined,
  }));

  return NextResponse.json({ codes: result });
}

export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const { code, name, organization, chat_limit, infographic_limit, device_limit } = await req.json();

  if (!code || !name) {
    return NextResponse.json(
      { error: "Код и имя обязательны" },
      { status: 400 }
    );
  }

  const supabase = createServiceClient();

  // Проверяем уникальность кода
  const { data: existing } = await supabase
    .from("invite_codes")
    .select("id")
    .eq("code", code.toUpperCase())
    .single();

  if (existing) {
    return NextResponse.json(
      { error: "Такой код уже существует" },
      { status: 409 }
    );
  }

  const { data, error } = await supabase
    .from("invite_codes")
    .insert({
      code: code.toUpperCase(),
      name,
      organization: organization || null,
      chat_limit: chat_limit ?? null,
      infographic_limit: infographic_limit ?? null,
      device_limit: device_limit ?? 2,
    })
    .select()
    .single();

  if (error) {
    console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  logAuditEvent({ action: "invite_code.create", adminName: adminCheck.adminName, targetId: data?.id, details: { code: code.toUpperCase(), name } });
  return NextResponse.json({ code: data });
}

export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  // Удаление кодов доступно только админам с canDeleteCodes=true
  const rawCode = req.headers.get("x-admin-code") ?? "";
  const code = decodeURIComponent(rawCode);
  if (!isCodeDeletionAdmin(code)) {
    return NextResponse.json({ error: "Недостаточно прав для удаления инвайт-кодов" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id обязателен" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { error } = await supabase
    .from("invite_codes")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  logAuditEvent({ action: "invite_code.delete", adminName: adminCheck.adminName, targetId: id });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id обязателен" }, { status: 400 });
  }

  const body = await req.json();
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.organization !== undefined) updates.organization = body.organization;
  if (body.chat_limit !== undefined) updates.chat_limit = body.chat_limit;
  if (body.infographic_limit !== undefined) updates.infographic_limit = body.infographic_limit;
  if (body.device_limit !== undefined) updates.device_limit = body.device_limit;
  if (body.is_active !== undefined) updates.is_active = body.is_active;
  // Сброс 2FA (admin action)
  if (body.reset_2fa === true) {
    updates.telegram_chat_id = null;
    updates.phone_number = null;
    updates.totp_secret = null;
  }
  // Сброс пароля (admin action)
  if (body.reset_password === true) {
    updates.password_hash = null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Нечего обновлять" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("invite_codes")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  logAuditEvent({ action: "invite_code.update", adminName: adminCheck.adminName, targetId: id, details: updates });
  return NextResponse.json({ code: data });
}
