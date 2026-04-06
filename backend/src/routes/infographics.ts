import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { getInviteCodeFromHeader, isAdminCode } from "../lib/auth.js";

const router = Router();

/**
 * GET /api/infographics — list infographics for the current user
 * Returns lightweight list (no image_base64) for sidebar cards.
 */
router.get("/api/infographics", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const supabase = createServiceClient();
    const isAdmin = isAdminCode(invite.code);

    // For admins, we get infographics from conversations owned by this admin.
    // For users, filter by invite_code_id directly.
    let query = supabase
      .from("infographics")
      .select("id, topic, style, aspect_ratio, description, created_at, conversation_id")
      .order("created_at", { ascending: false })
      .limit(100);

    if (!isAdmin) {
      query = query.eq("invite_code_id", invite.id);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Infographics GET error:", error.message);
      return res.status(500).json({ error: "Ошибка сервера" });
    }

    return res.json({ infographics: data || [] });
  } catch (err) {
    console.error("[infographics] GET error:", err);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * POST /api/infographics — get single infographic with image_base64 by id (for viewing)
 */
router.post("/api/infographics", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("infographics")
      .select("id, topic, style, aspect_ratio, description, image_base64, created_at")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Не найдено" });
    }

    return res.json({ infographic: data });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * DELETE /api/infographics?id=xxx — delete one infographic
 */
router.delete("/api/infographics", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = req.query.id as string;

    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    const supabase = createServiceClient();

    const { error } = await supabase
      .from("infographics")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Infographics DELETE error:", error.message);
      return res.status(500).json({ error: "Ошибка удаления" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[infographics] DELETE error:", err);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/infographics — rename an infographic
 */
router.patch("/api/infographics", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id, topic } = req.body;
    if (!id || !topic || typeof topic !== "string") {
      return res.status(400).json({ error: "Missing id or topic" });
    }

    const supabase = createServiceClient();

    const { error } = await supabase
      .from("infographics")
      .update({ topic: topic.trim().slice(0, 200) })
      .eq("id", id);

    if (error) {
      console.error("Rename infographic error:", error.message);
      return res.status(500).json({ error: "Ошибка переименования" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[infographics] PATCH error:", err);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

export default router;
