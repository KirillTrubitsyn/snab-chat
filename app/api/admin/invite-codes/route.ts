import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

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
    return NextResponse.json({ error: error.message }, { status: 500 });
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

  const result = (codes || []).map((code) => ({
    ...code,
    conversation_count: convCounts[code.id] || 0,
  }));

  return NextResponse.json({ codes: result });
}

export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const { code, name, uses_remaining } = await req.json();

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
      uses_remaining: uses_remaining ?? null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ code: data });
}

export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

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
  if (body.uses_remaining !== undefined) updates.uses_remaining = body.uses_remaining;
  if (body.is_active !== undefined) updates.is_active = body.is_active;

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ code: data });
}
