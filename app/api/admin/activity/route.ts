import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();

  // Получаем пользовательские сообщения (запросы) с привязкой к диалогу
  const { data: messages, error: msgError } = await supabase
    .from("messages")
    .select("id, conversation_id, role, content, metadata, created_at")
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(500);

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  // Также получаем инфографики (assistant messages с metadata.type = infographic)
  const { data: infographics } = await supabase
    .from("messages")
    .select("id, conversation_id, content, metadata, created_at")
    .eq("role", "assistant")
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  // Фильтруем только инфографики
  const infographicMessages = (infographics || []).filter(
    (m) => m.metadata?.type === "infographic"
  );

  // Получаем conversation_ids для маппинга на invite_code_id
  const allConvIds = [
    ...new Set([
      ...(messages || []).map((m) => m.conversation_id),
      ...infographicMessages.map((m) => m.conversation_id),
    ]),
  ].filter(Boolean);

  // Получаем диалоги с invite_code_id
  let convsMap: Record<string, string | null> = {};
  if (allConvIds.length > 0) {
    const { data: convs } = await supabase
      .from("conversations")
      .select("id, invite_code_id")
      .in("id", allConvIds);

    (convs || []).forEach((c) => {
      convsMap[c.id] = c.invite_code_id;
    });
  }

  // Получаем инвайт-коды для имён и организаций
  const inviteCodeIds = [
    ...new Set(Object.values(convsMap).filter(Boolean)),
  ] as string[];

  let codesMap: Record<string, { name: string; organization: string | null }> = {};
  if (inviteCodeIds.length > 0) {
    const { data: codes } = await supabase
      .from("invite_codes")
      .select("id, name, organization")
      .in("id", inviteCodeIds);

    (codes || []).forEach((c) => {
      codesMap[c.id] = { name: c.name, organization: c.organization };
    });
  }

  // Формируем результат: чат-запросы
  const chatItems = (messages || [])
    .filter((m) => convsMap[m.conversation_id] != null) // только с invite_code_id
    .map((m) => {
      const inviteId = convsMap[m.conversation_id]!;
      const codeInfo = codesMap[inviteId];
      return {
        id: m.id,
        type: "chat" as const,
        user_name: codeInfo?.name || "Неизвестный",
        organization: codeInfo?.organization || null,
        content: m.content.slice(0, 120) + (m.content.length > 120 ? "…" : ""),
        created_at: m.created_at,
      };
    });

  // Формируем результат: инфографики
  const infographicItems = infographicMessages
    .filter((m) => convsMap[m.conversation_id] != null)
    .map((m) => {
      const inviteId = convsMap[m.conversation_id]!;
      const codeInfo = codesMap[inviteId];
      return {
        id: m.id,
        type: "infographic" as const,
        user_name: codeInfo?.name || "Неизвестный",
        organization: codeInfo?.organization || null,
        content: m.metadata?.topic || m.content.slice(0, 120),
        created_at: m.created_at,
      };
    });

  // Объединяем и сортируем по дате
  const result = [...chatItems, ...infographicItems].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  ).slice(0, 300);

  return NextResponse.json({ activity: result });
}

// Удаление старых диалогов без привязки к инвайт-коду
export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();

  // Находим диалоги без invite_code_id
  const { data: orphaned } = await supabase
    .from("conversations")
    .select("id")
    .is("invite_code_id", null);

  const orphanedIds = (orphaned || []).map((c: { id: string }) => c.id);

  if (orphanedIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  // Удаляем сообщения, затем диалоги
  await supabase.from("messages").delete().in("conversation_id", orphanedIds);
  const { error } = await supabase.from("conversations").delete().in("id", orphanedIds);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: orphanedIds.length });
}
