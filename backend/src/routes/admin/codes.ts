import { Router, Request, Response } from "express";
import { requireAdmin } from "../../lib/auth.js";
import { createServiceClient } from "../../lib/supabase.js";
import { logAuditEvent } from "../../lib/audit-log.js";

const router = Router();

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

export default router;
