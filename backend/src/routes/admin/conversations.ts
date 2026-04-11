import { Router, Request, Response } from "express";
import { requireAdmin, getAdminNumber } from "../../lib/auth.js";
import { createServiceClient } from "../../lib/supabase.js";
import { logAuditEvent } from "../../lib/audit-log.js";
import { notifySupportReply } from "../../lib/telegram.js";
import { supportReplySchema, parseBody } from "../../lib/validation.js";

const router = Router();

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
