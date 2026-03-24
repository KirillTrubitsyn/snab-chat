import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { notifySupportMessage } from "@/app/lib/telegram";

export async function GET(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return NextResponse.json({ error: "Требуется инвайт-код" }, { status: 401 });

  const supabase = createServiceClient();

  // Для обычных пользователей — только свои обращения
  // Для админов — их обращения (по user_name, т.к. invite_code_id = null)
  let query = supabase
    .from("support_messages")
    .select("id, message, admin_reply, admin_number, status, created_at, replied_at")
    .order("created_at", { ascending: true })
    .limit(100);

  if (isAdminCode(invite.code)) {
    query = query.eq("user_name", invite.name);
  } else {
    query = query.eq("invite_code_id", invite.id);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: data ?? [] });
}

export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return NextResponse.json({ error: "Требуется инвайт-код" }, { status: 401 });

  const { message } = await req.json();
  if (!message || typeof message !== "string" || message.trim().length < 3) {
    return NextResponse.json({ error: "Сообщение слишком короткое" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const inviteCodeId = invite.id.startsWith("admin-") ? null : invite.id;

  const { data: inserted, error } = await supabase.from("support_messages").insert({
    invite_code_id: inviteCodeId,
    user_name: invite.name,
    organization: invite.organization ?? null,
    message: message.trim().slice(0, 5000),
  }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Telegram notification с REF:id для ответа через ТГ (fire-and-forget)
  notifySupportMessage(invite.name, message.trim(), invite.organization, inserted?.id).catch(() => {});

  return NextResponse.json({ success: true });
}
