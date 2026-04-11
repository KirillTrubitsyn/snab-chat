import { Router, Request, Response } from "express";
import { requireAdmin, getAdminNumber } from "../lib/auth.js";
import { createServiceClient } from "../lib/supabase.js";
import { logAuditEvent } from "../lib/audit-log.js";
import { notifySupportReply } from "../lib/telegram.js";
import { supportReplySchema, parseBody } from "../lib/validation.js";

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
            assistant_response: m.content.slice(0, 200) + (m.content.length > 200 ? "…" : ""),
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
   /api/admin/invite-codes  —  GET, POST, DELETE, PATCH
   ══════════════════════════════════════════════════════════════ */

router.get("/api/admin/invite-codes", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();

    const { data: codes, error } = await supabase
      .from("invite_codes")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    const { data: convStats } = await supabase
      .from("conversations")
      .select("invite_code_id");

    const convCounts: Record<string, number> = {};
    (convStats || []).forEach((c) => {
      if (c.invite_code_id) {
        convCounts[c.invite_code_id] = (convCounts[c.invite_code_id] || 0) + 1;
      }
    });

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
      // Strip sensitive fields
      password_hash: undefined,
      telegram_chat_id: undefined,
      phone_number: undefined,
      totp_secret: undefined,
    }));

    return res.json({ codes: result });
  } catch (err) {
    console.error("GET /api/admin/invite-codes error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.post("/api/admin/invite-codes", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const { code, name, organization, chat_limit, infographic_limit, device_limit } = req.body;

    if (!code || !name) {
      return res.status(400).json({ error: "Код и имя обязательны" });
    }

    const supabase = createServiceClient();

    const { data: existing } = await supabase
      .from("invite_codes")
      .select("id")
      .eq("code", code.toUpperCase())
      .single();

    if (existing) {
      return res.status(409).json({ error: "Такой код уже существует" });
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
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    logAuditEvent({ action: "invite_code.create", adminName: admin.adminName, targetId: data?.id, details: { code: code.toUpperCase(), name } });
    return res.json({ code: data });
  } catch (err) {
    console.error("POST /api/admin/invite-codes error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.delete("/api/admin/invite-codes", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const id = req.query.id as string | undefined;

    if (!id) {
      return res.status(400).json({ error: "id обязателен" });
    }

    const supabase = createServiceClient();

    const { error } = await supabase
      .from("invite_codes")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    logAuditEvent({ action: "invite_code.delete", adminName: admin.adminName, targetId: id });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/invite-codes error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.patch("/api/admin/invite-codes", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const id = req.query.id as string | undefined;

    if (!id) {
      return res.status(400).json({ error: "id обязателен" });
    }

    const body = req.body;
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.organization !== undefined) updates.organization = body.organization;
    if (body.chat_limit !== undefined) updates.chat_limit = body.chat_limit;
    if (body.infographic_limit !== undefined) updates.infographic_limit = body.infographic_limit;
    if (body.device_limit !== undefined) updates.device_limit = body.device_limit;
    if (body.is_active !== undefined) updates.is_active = body.is_active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Нечего обновлять" });
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("invite_codes")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    logAuditEvent({ action: "invite_code.update", adminName: admin.adminName, targetId: id, details: updates });
    // Strip sensitive fields from response
    if (data) {
      const { password_hash: _ph, totp_secret: _ts, ...safeData } = data as Record<string, unknown>;
      return res.json({ code: safeData });
    }
    return res.json({ code: data });
  } catch (err) {
    console.error("PATCH /api/admin/invite-codes error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/* ══════════════════════════════════════════════════════════════
   /api/admin/errors  —  GET, DELETE
   ══════════════════════════════════════════════════════════════ */

router.get("/api/admin/errors", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();
    const days = parseInt((req.query.days as string) ?? "7", 10);
    const type = req.query.type as string | undefined;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    let query = supabase
      .from("error_logs")
      .select("id, error_type, error_message, endpoint, user_name, organization, metadata, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    if (type && type !== "all") query = query.eq("error_type", type);

    const { data, error } = await query;
    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    return res.json({ errors: data ?? [] });
  } catch (err) {
    console.error("GET /api/admin/errors error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.delete("/api/admin/errors", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ error: "id обязателен" });

    const supabase = createServiceClient();
    const { error } = await supabase.from("error_logs").delete().eq("id", id);
    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    return res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /api/admin/errors error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/* ══════════════════════════════════════════════════════════════
   /api/admin/support  —  GET, PATCH, DELETE
   ══════════════════════════════════════════════════════════════ */

router.get("/api/admin/support", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();
    const status = req.query.status as string | undefined;

    let query = supabase
      .from("support_messages")
      .select("id, user_name, organization, message, admin_reply, admin_number, status, created_at, replied_at")
      .order("created_at", { ascending: false })
      .limit(500);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    const items = data ?? [];
    const stats = {
      total: items.length,
      open: items.filter((m) => m.status === "open").length,
      answered: items.filter((m) => m.status === "answered").length,
      closed: items.filter((m) => m.status === "closed").length,
    };

    return res.json({ messages: items, stats });
  } catch (err) {
    console.error("GET /api/admin/support error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.patch("/api/admin/support", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const rawCode = decodeURIComponent((req.headers["x-admin-code"] as string) ?? "");
    const adminNumber = getAdminNumber(rawCode);
    const { adminName } = admin;

    const parsed = parseBody(req.body, supportReplySchema, res);
    if (parsed.error) return;
    const { id, reply, status: newStatus } = parsed.data;

    const supabase = createServiceClient();
    const update: Record<string, unknown> = {};

    if (reply && typeof reply === "string") {
      update.admin_reply = reply.trim().slice(0, 5000);
      update.admin_number = adminNumber;
      update.status = "answered";
      update.replied_at = new Date().toISOString();
    }

    if (newStatus && ["open", "answered", "closed"].includes(newStatus)) {
      update.status = newStatus;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "Нечего обновлять" });
    }

    const { error } = await supabase.from("support_messages").update(update).eq("id", id);
    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    // Notify other admins about the reply
    if (reply) {
      const { data: msg } = await supabase
        .from("support_messages")
        .select("user_name")
        .eq("id", id)
        .single();
      const userName = msg?.user_name;
      if (userName) {
        notifySupportReply(adminName, userName, reply).catch(() => {});
      }
    }

    logAuditEvent({ action: reply ? "support.reply" : "support.status_change", adminName: admin.adminName, targetId: id, details: { newStatus, hasReply: !!reply } });
    return res.json({ success: true });
  } catch (err) {
    console.error("PATCH /api/admin/support error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.delete("/api/admin/support", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ error: "id обязателен" });

    const supabase = createServiceClient();
    const { error } = await supabase.from("support_messages").delete().eq("id", id);
    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    logAuditEvent({ action: "support.delete", adminName: admin.adminName, targetId: id });
    return res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /api/admin/support error:", err);
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

/* ══════════════════════════════════════════════════════════════
   /api/admin/off-topic  —  GET, DELETE
   ══════════════════════════════════════════════════════════════ */

router.get("/api/admin/off-topic", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();
    const days = parseInt((req.query.days as string) ?? "7", 10);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: queries, error } = await supabase
      .from("off_topic_queries")
      .select("id, user_name, organization, category, query_text, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    const items = queries ?? [];

    const byCategory: Record<string, number> = {};
    const byUser: Record<string, { count: number; lastQuery: string; lastDate: string }> = {};
    for (const q of items) {
      byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
      if (!byUser[q.user_name]) {
        byUser[q.user_name] = { count: 0, lastQuery: q.query_text, lastDate: q.created_at };
      }
      byUser[q.user_name].count++;
    }

    return res.json({
      queries: items,
      stats: { total: items.length, by_category: byCategory, by_user: byUser },
    });
  } catch (err) {
    console.error("GET /api/admin/off-topic error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.delete("/api/admin/off-topic", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ error: "id обязателен" });

    const supabase = createServiceClient();
    const { error } = await supabase.from("off_topic_queries").delete().eq("id", id);
    if (error) {
      console.error("DB error:", error.message);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    return res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /api/admin/off-topic error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export default router;
