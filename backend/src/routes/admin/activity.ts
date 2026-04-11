import { Router, Request, Response } from "express";
import { requireAdmin } from "../../lib/auth.js";
import { createServiceClient } from "../../lib/supabase.js";
import { logAuditEvent } from "../../lib/audit-log.js";

const router = Router();

/* ══════════════════════════════════════════════════════════════
   Helpers (activity)
   ══════════════════════════════════════════════════════════════ */

type ConvInfo = { invite_code_id: string | null; admin_name: string | null };

async function buildConvsAndCodesMap(
  supabase: ReturnType<typeof createServiceClient>,
  convIds: string[]
) {
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

/* ══════════════════════════════════════════════════════════════
   /api/admin/activity  —  GET, DELETE
   ══════════════════════════════════════════════════════════════ */

router.get("/api/admin/activity", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();
    const type = req.query.type as string | undefined;

    // ── Type: nontarget ──
    if (type === "nontarget") {
      const { data: nontargetMsgs, error } = await supabase
        .from("messages")
        .select("id, conversation_id, content, metadata, created_at")
        .eq("role", "assistant")
        .not("metadata", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) {
        console.error("DB error:", error.message);
        return res.status(500).json({ error: "Внутренняя ошибка сервера" });
      }

      const lowConfMsgs = (nontargetMsgs || []).filter(
        (m) => m.metadata?.lowConfidence === true
      );

      if (lowConfMsgs.length === 0) {
        return res.json({ nontarget: [] });
      }

      const convIds = [...new Set(lowConfMsgs.map((m) => m.conversation_id))].filter(Boolean);
      const { convsMap, codesMap } = await buildConvsAndCodesMap(supabase, convIds);

      const convIdsForUserMsgs = lowConfMsgs.map((m) => m.conversation_id).filter(Boolean);
      const { data: userMsgs } = await supabase
        .from("messages")
        .select("id, conversation_id, content, created_at")
        .eq("role", "user")
        .in("conversation_id", convIdsForUserMsgs)
        .order("created_at", { ascending: false });

      const userMsgsByConv: Record<string, { content: string; created_at: string }[]> = {};
      (userMsgs || []).forEach((m) => {
        if (!userMsgsByConv[m.conversation_id]) userMsgsByConv[m.conversation_id] = [];
        userMsgsByConv[m.conversation_id].push({ content: m.content, created_at: m.created_at });
      });

      const result = lowConfMsgs
        .filter((m) => m.conversation_id in convsMap)
        .map((m) => {
          const convUserMsgs = userMsgsByConv[m.conversation_id] || [];
          const userMsg = convUserMsgs.find(
            (um) => new Date(um.created_at).getTime() <= new Date(m.created_at).getTime()
          );
          return {
            id: m.id,
            ...resolveUser(m.conversation_id, convsMap, codesMap),
            user_question: userMsg?.content || "—",
            assistant_response: m.content.slice(0, 200) + (m.content.length > 200 ? "..." : ""),
            created_at: m.created_at,
          };
        });

      return res.json({ nontarget: result });
    }

    // ── Type: messages ──
    if (type === "messages") {
      const { data: userMsgs, error } = await supabase
        .from("messages")
        .select("id, conversation_id, content, created_at")
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!userMsgs || userMsgs.length === 0) {
        return res.json({ messages: [] });
      }

      const convIds = [...new Set(userMsgs.map((m) => m.conversation_id))].filter(Boolean);
      const { convsMap, codesMap } = await buildConvsAndCodesMap(supabase, convIds);

      const { data: asstMsgs } = await supabase
        .from("messages")
        .select("conversation_id, metadata, created_at")
        .eq("role", "assistant")
        .in("conversation_id", convIds)
        .order("created_at", { ascending: false })
        .limit(1000);

      const asstByConv: Record<string, { metadata: Record<string, unknown> | null; created_at: string }[]> = {};
      for (const m of asstMsgs || []) {
        if (!asstByConv[m.conversation_id]) asstByConv[m.conversation_id] = [];
        asstByConv[m.conversation_id].push({ metadata: m.metadata, created_at: m.created_at });
      }

      const result = userMsgs
        .filter((m) => m.conversation_id in convsMap)
        .map((m) => {
          const convAsst = asstByConv[m.conversation_id] || [];
          const nextAsst = convAsst
            .filter((a) => new Date(a.created_at).getTime() >= new Date(m.created_at).getTime())
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];

          const model = (nextAsst?.metadata?.model as string) || null;

          return {
            id: m.id,
            ...resolveUser(m.conversation_id, convsMap, codesMap),
            content: m.content,
            model,
            created_at: m.created_at,
          };
        });

      return res.json({ messages: result });
    }

    // ── Default: activity feed (chat + infographic) ──

    const [
      { data: messages, error: msgError },
      { data: assistantMsgs },
      { data: offTopicRows },
      { data: infographicRows },
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
      supabase
        .from("infographics")
        .select("id, invite_code_id, conversation_id, topic, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (msgError) {
      return res.status(500).json({ error: msgError.message });
    }

    const offTopicTexts = new Set((offTopicRows || []).map((r) => r.query_text));

    const asstByConvActivity: Record<string, { metadata: Record<string, unknown> | null; created_at: string }[]> = {};
    for (const m of assistantMsgs || []) {
      if (!asstByConvActivity[m.conversation_id]) asstByConvActivity[m.conversation_id] = [];
      asstByConvActivity[m.conversation_id].push({ metadata: m.metadata, created_at: m.created_at });
    }

    const allConvIds = [
      ...new Set([
        ...(messages || []).map((m) => m.conversation_id),
        ...(infographicRows || []).map((ig) => ig.conversation_id).filter(Boolean),
      ]),
    ].filter(Boolean);

    const { convsMap, codesMap } = await buildConvsAndCodesMap(supabase, allConvIds);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const igCodeIds = [...new Set((infographicRows || []).map((ig: any) => ig.invite_code_id).filter(Boolean) as string[])]
      .filter((id: string) => !(id in codesMap));
    if (igCodeIds.length > 0) {
      const { data: extraCodes } = await supabase
        .from("invite_codes")
        .select("id, name, organization")
        .in("id", igCodeIds);
      (extraCodes || []).forEach((c) => {
        codesMap[c.id] = { name: c.name, organization: c.organization };
      });
    }

    const chatItems = (messages || [])
      .filter((m) => {
        if (!(m.conversation_id in convsMap)) return false;
        if (offTopicTexts.has(m.content.slice(0, 5000))) return false;
        return true;
      })
      .map((m) => {
        const convAsst = asstByConvActivity[m.conversation_id] || [];
        const nextAsst = convAsst
          .filter((a) => new Date(a.created_at).getTime() >= new Date(m.created_at).getTime())
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];
        return {
          id: m.id,
          type: "chat" as const,
          ...resolveUser(m.conversation_id, convsMap, codesMap),
          content: m.content,
          model: (nextAsst?.metadata?.model as string) || null,
          created_at: m.created_at,
        };
      });

    const infographicItems = (infographicRows || []).map((ig) => {
      let user_name = "Неизвестный";
      let organization: string | null = "";
      if (ig.conversation_id && ig.conversation_id in convsMap) {
        const resolved = resolveUser(ig.conversation_id, convsMap, codesMap);
        user_name = resolved.user_name;
        organization = resolved.organization;
      } else if (ig.invite_code_id && ig.invite_code_id in codesMap) {
        const code = codesMap[ig.invite_code_id];
        user_name = code.name || "Неизвестный";
        organization = code.organization || "";
      }
      return {
        id: ig.id,
        type: "infographic" as const,
        user_name,
        organization,
        content: ig.topic || "Инфографика",
        model: null,
        created_at: ig.created_at,
      };
    });

    const result = [...chatItems, ...infographicItems].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    ).slice(0, 300);

    return res.json({ activity: result });
  } catch (err) {
    console.error("GET /api/admin/activity error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.delete("/api/admin/activity", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();
    const type = req.query.type as string | undefined;

    // ── Delete specific messages by IDs ──
    if (type === "messages") {
      const idsParam = req.query.ids as string | undefined;
      if (!idsParam) return res.status(400).json({ error: "ids required" });
      const ids = idsParam.split(",").filter(Boolean);
      if (ids.length === 0) return res.json({ deleted: 0 });

      const { error } = await supabase.from("messages").delete().in("id", ids);
      if (error) {
        console.error("DB error:", error.message);
        return res.status(500).json({ error: "Внутренняя ошибка сервера" });
      }
      return res.json({ deleted: ids.length });
    }

    // ── Default: delete orphaned conversations ──

    const orphanedQuery = supabase
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
      return res.json({ deleted: 0 });
    }

    await supabase.from("messages").delete().in("conversation_id", orphanedIds);
    const { error } = await supabase.from("conversations").delete().in("id", orphanedIds);

    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    return res.json({ deleted: orphanedIds.length });
  } catch (err) {
    console.error("DELETE /api/admin/activity error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/* ══════════════════════════════════════════════════════════════
   /api/admin/online-users  —  GET
   ══════════════════════════════════════════════════════════════ */

router.get("/api/admin/online-users", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();

    // "Online" = last_seen_at within the last 5 minutes
    const ONLINE_THRESHOLD_MINUTES = 5;
    const cutoff = new Date(Date.now() - ONLINE_THRESHOLD_MINUTES * 60 * 1000).toISOString();

    // Get all devices seen recently
    const { data: recentDevices, error: devErr } = await supabase
      .from("devices")
      .select("invite_code_id, device_id, user_agent, last_seen_at")
      .gte("last_seen_at", cutoff)
      .order("last_seen_at", { ascending: false });

    if (devErr) {
      console.error("DB error:", devErr.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    if (!recentDevices || recentDevices.length === 0) {
      return res.json({ users: [], count: 0 });
    }

    // Group by invite_code_id
    const byUser: Record<string, { devices: typeof recentDevices; lastSeen: string }> = {};
    for (const d of recentDevices) {
      if (!d.invite_code_id) continue;
      if (!byUser[d.invite_code_id]) {
        byUser[d.invite_code_id] = { devices: [], lastSeen: d.last_seen_at };
      }
      byUser[d.invite_code_id].devices.push(d);
      if (d.last_seen_at > byUser[d.invite_code_id].lastSeen) {
        byUser[d.invite_code_id].lastSeen = d.last_seen_at;
      }
    }

    const inviteCodeIds = Object.keys(byUser);

    // Get user info
    const { data: codes } = await supabase
      .from("invite_codes")
      .select("id, code, name, organization")
      .in("id", inviteCodeIds);

    const codesMap: Record<string, { code: string; name: string; organization: string | null }> = {};
    for (const c of codes || []) {
      codesMap[c.id] = { code: c.code, name: c.name, organization: c.organization };
    }

    const users = inviteCodeIds
      .filter((id) => id in codesMap)
      .map((id) => ({
        invite_code_id: id,
        code: codesMap[id].code,
        name: codesMap[id].name,
        organization: codesMap[id].organization,
        device_count: byUser[id].devices.length,
        last_seen_at: byUser[id].lastSeen,
      }))
      .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));

    return res.json({ users, count: users.length });
  } catch (err) {
    console.error("GET /api/admin/online-users error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/* ══════════════════════════════════════════════════════════════
   /api/admin/disconnect-user  —  POST
   ══════════════════════════════════════════════════════════════ */

router.post("/api/admin/disconnect-user", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const { invite_code_id } = req.body;
    if (!invite_code_id || typeof invite_code_id !== "string") {
      return res.status(400).json({ error: "invite_code_id обязателен" });
    }

    const supabase = createServiceClient();

    // Get user info for audit log
    const { data: codeInfo } = await supabase
      .from("invite_codes")
      .select("name, code")
      .eq("id", invite_code_id)
      .single();

    // Delete all devices for this user (forces logout on next heartbeat)
    const { error } = await supabase
      .from("devices")
      .delete()
      .eq("invite_code_id", invite_code_id);

    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    logAuditEvent({
      action: "user.disconnect",
      adminName: admin.adminName,
      targetId: invite_code_id,
      details: { userName: codeInfo?.name, code: codeInfo?.code },
    });

    return res.json({ ok: true, userName: codeInfo?.name });
  } catch (err) {
    console.error("POST /api/admin/disconnect-user error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export default router;
