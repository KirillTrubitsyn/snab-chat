import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();

  // Получаем все диалоги с информацией об инвайт-коде
  const { data: conversations, error: convError } = await supabase
    .from("conversations")
    .select("id, title, invite_code_id, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);

  if (convError) {
    return NextResponse.json({ error: convError.message }, { status: 500 });
  }

  // Получаем количество сообщений для каждого диалога
  const convIds = (conversations || []).map((c) => c.id);
  const { data: msgCounts } = await supabase
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", convIds.length > 0 ? convIds : ["__none__"]);

  const messageCounts: Record<string, number> = {};
  (msgCounts || []).forEach((m) => {
    messageCounts[m.conversation_id] = (messageCounts[m.conversation_id] || 0) + 1;
  });

  // Получаем инвайт-коды для привязки имён
  const inviteCodeIds = [
    ...new Set(
      (conversations || [])
        .map((c) => c.invite_code_id)
        .filter(Boolean)
    ),
  ];

  let inviteCodesMap: Record<string, string> = {};
  if (inviteCodeIds.length > 0) {
    const { data: codes } = await supabase
      .from("invite_codes")
      .select("id, name, code")
      .in("id", inviteCodeIds);

    (codes || []).forEach((c) => {
      inviteCodesMap[c.id] = `${c.name} (${c.code})`;
    });
  }

  const result = (conversations || []).map((c) => ({
    id: c.id,
    title: c.title,
    invite_code_id: c.invite_code_id,
    invite_code_label: c.invite_code_id
      ? inviteCodesMap[c.invite_code_id] || "Неизвестный код"
      : "Без кода (старый диалог)",
    message_count: messageCounts[c.id] || 0,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));

  return NextResponse.json({ activity: result });
}
