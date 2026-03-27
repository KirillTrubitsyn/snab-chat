import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

/* ── Helpers ── */

type ConvInfo = { invite_code_id: string | null; admin_name: string | null };

async function buildConvsAndCodesMap(supabase: ReturnType<typeof createServiceClient>, convIds: string[]) {
  const convsMap: Record<string, ConvInfo> = {};
  const codesMap: Record<string, { name: string; organization: string | null }> = {};

  if (convIds.length === 0) return { convsMap, codesMap };

  // Conversations
  let convs: { id: string; invite_code_id: string | null; admin_name?: string | null }[] | null = null;
  const { data: convsWithAdmin, error: convErr } = await supabase
    .from("conversations")
    .select("id, invite_code_id, admin_name")
    .in("id", convIds);

  if (convErr) {
    const { data: convsBasic } = await supabase
      .from("conversations")
      .select("id, invite_code_id")
      .in("id", convIds);
    convs = convsBasic;
  } else {
    convs = convsWithAdmin;
  }

  (convs || []).forEach((c) => {
    convsMap[c.id] = { invite_code_id: c.invite_code_id, admin_name: c.admin_name ?? null };
  });

  // Invite codes
  const inviteCodeIds = [
    ...new Set(Object.values(convsMap).map((c) => c.invite_code_id).filter(Boolean)),
  ] as string[];

  if (inviteCodeIds.length > 0) {
    const { data: codes } = await supabase
      .from("invite_codes")
      .select("id, name, organization")
      .in("id", inviteCodeIds);

    (codes || []).forEach((c) => {
      codesMap[c.id] = { name: c.name, organization: c.organization };
    });
  }

  return { convsMap, codesMap };
}

function resolveUser(
  conversationId: string,
  convsMap: Record<string, ConvInfo>,
  codesMap: Record<string, { name: string; organization: string | null }>
) {
  const conv = convsMap[conversationId];
  if (!conv) return { user_name: "Неизвестный", organization: null as string | null };
  const inviteId = conv.invite_code_id;
  if (inviteId) {
    const codeInfo = codesMap[inviteId];
    return {
      user_name: codeInfo?.name || "Неизвестный",
      organization: codeInfo?.organization || null,
    };
  }
  return {
    user_name: conv.admin_name || "Админ",
    organization: "Админ",
  };
}

/* ── GET /api/admin/activity ── */

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();
  const type = req.nextUrl.searchParams.get("type");

  // ── Type: nontarget ── Non-target queries (lowConfidence assistant messages)
  if (type === "nontarget") {
    // Get assistant messages marked with lowConfidence
    const { data: nontargetMsgs, error } = await supabase
      .from("messages")
      .select("id, conversation_id, content, metadata, created_at")
      .eq("role", "assistant")
      .not("metadata", "is", null)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error("DB error:", error.message);
      return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
    }

    // Filter for lowConfidence in JS (jsonb filtering can be tricky across Supabase versions)
    const lowConfMsgs = (nontargetMsgs || []).filter(
      (m) => m.metadata?.lowConfidence === true
    );

    if (lowConfMsgs.length === 0) {
      return NextResponse.json({ nontarget: [] });
    }

    // Get conversation IDs for user resolution
    const convIds = [...new Set(lowConfMsgs.map((m) => m.conversation_id))].filter(Boolean);
    const { convsMap, codesMap } = await buildConvsAndCodesMap(supabase, convIds);

    // For each non-target assistant message, find the preceding user message
    const convIdsForUserMsgs = lowConfMsgs.map((m) => m.conversation_id).filter(Boolean);
    const { data: userMsgs } = await supabase
      .from("messages")
      .select("id, conversation_id, content, created_at")
      .eq("role", "user")
      .in("conversation_id", convIdsForUserMsgs)
      .order("created_at", { ascending: false });

    // Build a map: conversation_id → latest user messages
    const userMsgsByConv: Record<string, { content: string; created_at: string }[]> = {};
    (userMsgs || []).forEach((m) => {
      if (!userMsgsByConv[m.conversation_id]) userMsgsByConv[m.conversation_id] = [];
      userMsgsByConv[m.conversation_id].push({ content: m.content, created_at: m.created_at });
    });

    const result = lowConfMsgs
      .filter((m) => m.conversation_id in convsMap)
      .map((m) => {
        // Find the user message closest before this assistant message
        const convUserMsgs = userMsgsByConv[m.conversation_id] || [];
        const userMsg = convUserMsgs.find(
          (um) => new Date(um.created_at).getTime() <= new Date(m.created_at).getTime()
        );
        return {
          id: m.id,
          ...resolveUser(m.conversation_id, convsMap, codesMap),
          user_question: userMsg?.content || "—",
          assistant_response: m.content.slice(0, 200) + (m.content.length > 200 ? "…" : ""),
          created_at: m.created_at,
        };
      });

    return NextResponse.json({ nontarget: result });
  }

  // ── Default: activity feed (chat + infographic) ──

  // Load user messages, assistant messages (for lowConfidence + infographic), and off_topic in parallel
  const [
    { data: messages, error: msgError },
    { data: assistantMsgs },
    { data: offTopicRows },
  ] = await Promise.all([
    supabase
      .from("messages")
      .select("id, conversation_id, role, content, metadata, created_at")
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("messages")
      .select("id, conversation_id, content, metadata, created_at")
      .eq("role", "assistant")
      .not("metadata", "is", null)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("off_topic_queries")
      .select("query_text")
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  // Build set of off-topic query texts to exclude from activity feed
  const offTopicTexts = new Set((offTopicRows || []).map((r) => r.query_text));

  const infographicMessages = (assistantMsgs || []).filter(
    (m) => m.metadata?.type === "infographic"
  );

  const allConvIds = [
    ...new Set([
      ...(messages || []).map((m) => m.conversation_id),
      ...infographicMessages.map((m) => m.conversation_id),
    ]),
  ].filter(Boolean);

  const { convsMap, codesMap } = await buildConvsAndCodesMap(supabase, allConvIds);

  // Filter out off-topic messages from activity feed
  const chatItems = (messages || [])
    .filter((m) => {
      if (!(m.conversation_id in convsMap)) return false;
      // Exclude if this exact text is in off_topic_queries
      if (offTopicTexts.has(m.content.slice(0, 5000))) return false;
      return true;
    })
    .map((m) => ({
      id: m.id,
      type: "chat" as const,
      ...resolveUser(m.conversation_id, convsMap, codesMap),
      content: m.content.slice(0, 120) + (m.content.length > 120 ? "…" : ""),
      created_at: m.created_at,
    }));

  const infographicItems = infographicMessages
    .filter((m) => m.conversation_id in convsMap)
    .map((m) => ({
      id: m.id,
      type: "infographic" as const,
      ...resolveUser(m.conversation_id, convsMap, codesMap),
      content: m.metadata?.topic || m.content.slice(0, 120),
      created_at: m.created_at,
    }));

  const result = [...chatItems, ...infographicItems].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  ).slice(0, 300);

  return NextResponse.json({ activity: result });
}

// DELETE /api/admin/activity
export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();
  const type = req.nextUrl.searchParams.get("type");

  // ── Delete specific messages by IDs ──
  if (type === "messages") {
    const idsParam = req.nextUrl.searchParams.get("ids");
    if (!idsParam) return NextResponse.json({ error: "ids required" }, { status: 400 });
    const ids = idsParam.split(",").filter(Boolean);
    if (ids.length === 0) return NextResponse.json({ deleted: 0 });

    const { error } = await supabase.from("messages").delete().in("id", ids);
    if (error) {
      console.error("DB error:", error.message);
      return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
    }
    return NextResponse.json({ deleted: ids.length });
  }

  // ── Default: Удаление старых диалогов без привязки к инвайт-коду ──

  let orphanedQuery = supabase
    .from("conversations")
    .select("id")
    .is("invite_code_id", null);

  const { data: orphaned, error: orphanErr } = await orphanedQuery.is("admin_name", null);
  let finalOrphaned = orphaned;
  if (orphanErr) {
    const { data: fallback } = await supabase
      .from("conversations")
      .select("id")
      .is("invite_code_id", null);
    finalOrphaned = fallback;
  }

  const orphanedIds = (finalOrphaned || []).map((c: { id: string }) => c.id);

  if (orphanedIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  await supabase.from("messages").delete().in("conversation_id", orphanedIds);
  const { error } = await supabase.from("conversations").delete().in("id", orphanedIds);

  if (error) {
    console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  return NextResponse.json({ deleted: orphanedIds.length });
}
