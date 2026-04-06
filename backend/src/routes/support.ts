import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { getInviteCodeFromHeader, isAdminCode } from "../lib/auth.js";
import { notifySupportMessage } from "../lib/telegram.js";
import { supportMessageSchema, parseBody } from "../lib/validation.js";

const router = Router();

router.get("/api/support", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return res.status(401).json({ error: "Unauthorized" });

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
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
    return res.json({ messages: data ?? [] });
  } catch (err) {
    console.error("GET /api/support error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.post("/api/support", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return res.status(401).json({ error: "Unauthorized" });

    const parsed = parseBody(req.body, supportMessageSchema, res);
    if (parsed.error) return;
    const message = parsed.data.message;

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
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    // Telegram notification с REF:id для ответа через ТГ (fire-and-forget)
    notifySupportMessage(invite.name, message.trim(), invite.organization, inserted?.id).catch(() => {});

    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/support error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export default router;
