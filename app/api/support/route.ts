import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { notifySupportMessage } from "@/app/lib/telegram";
import { unauthorizedResponse } from "@/app/lib/api-helpers";
import { supportMessageSchema, parseBody } from "@/app/lib/validation";

export async function GET(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return unauthorizedResponse();

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
  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
  return NextResponse.json({ messages: data ?? [] });
}

export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return unauthorizedResponse();

  const raw = await req.json();
  const { data, error: valError } = parseBody(raw, supportMessageSchema);
  if (valError) return valError;
  const message = data.message;

  const supabase = createServiceClient();
  const inviteCodeId = invite.id.startsWith("admin-") ? null : invite.id;

  const { data: inserted, error } = await supabase.from("support_messages").insert({
    invite_code_id: inviteCodeId,
    user_name: invite.name,
    organization: invite.organization ?? null,
    message,
  }).select("id").single();

  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  // Telegram notification с REF:id для ответа через ТГ (fire-and-forget)
  notifySupportMessage(invite!.name, message.trim(), invite!.organization, inserted?.id).catch(() => {});

  return NextResponse.json({ success: true });
}
