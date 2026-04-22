import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { getInviteCodeFromHeader, isAdminCode, normalizeAdminName } from "../lib/auth.js";
import { logAuditEvent } from "../lib/audit-log.js";
import {
  unauthorizedResponse,
  serverError,
  notFound,
  ok,
} from "../lib/api-helpers.js";

const router = Router();

// ============================================================
// GET /api/conversations — list conversations
// ============================================================

router.get("/api/conversations", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return unauthorizedResponse(res);
    }

    let supabase;
    try {
      supabase = createServiceClient();
    } catch (e) {
      console.error("Supabase init error:", e);
      return serverError(res);
    }

    let query = supabase
      .from("conversations")
      .select("id, title, created_at, updated_at, summary")
      .order("updated_at", { ascending: false })
      .limit(50);

    // Фильтрация: каждый видит только свои диалоги
    const adminName = normalizeAdminName(invite.name) || invite.name;
    if (isAdminCode(invite.code)) {
      query = query.eq("admin_name", adminName);
    } else {
      query = query.eq("invite_code_id", invite.id);
    }

    let data = null;
    let error = null;

    for (let attempt = 0; attempt <= 1; attempt++) {
      ({ data, error } = await query);
      if (!error) break;
      const msg = error.message ?? "";
      if (
        attempt === 0 &&
        /fetch|network|ECONNR|timeout|socket/i.test(msg)
      ) {
        console.warn(
          "[conversations] GET transient error, retrying:",
          msg
        );
        await new Promise((r) => setTimeout(r, 1000));
        // Re-create query for retry
        query = supabase
          .from("conversations")
          .select(
            "id, title, created_at, updated_at, summary"
          )
          .order("updated_at", { ascending: false })
          .limit(50);
        if (isAdminCode(invite.code)) {
          query = query.eq("admin_name", adminName);
        } else {
          query = query.eq("invite_code_id", invite.id);
        }
        continue;
      }
      break;
    }

    if (error) {
      console.error("DB error:", error.message);
      return serverError(res);
    }

    return res.json(
      (data || []).map((c) => ({
        ...c,
        hasSummary: !!c.summary,
        summary: undefined,
      }))
    );
  } catch (err) {
    console.error("[conversations] GET error:", err);
    return serverError(res);
  }
});

// ============================================================
// POST /api/conversations — create a conversation
// ============================================================

router.post("/api/conversations", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return unauthorizedResponse(res);
    }

    let supabase;
    try {
      supabase = createServiceClient();
    } catch (e) {
      console.error("Supabase init error:", e);
      return serverError(res);
    }

    const body = req.body || {};
    const title = body.title || "Новый диалог";

    // Для админов invite_code_id = null (они не привязаны к инвайт-кодам в БД)
    const isAdmin = isAdminCode(invite.code);
    const inviteCodeId = isAdmin ? null : invite.id;
    const adminName = isAdmin ? (normalizeAdminName(invite.name) || invite.name) : null;

    let insertData: Record<string, unknown> = {
      title,
      invite_code_id: inviteCodeId,
    };
    if (isAdmin) {
      insertData.admin_name = adminName;
    }

    // Retry logic for transient Supabase errors (TypeError: fetch failed)
    let data = null;
    let error = null;
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      ({ data, error } = await supabase
        .from("conversations")
        .insert(insertData)
        .select("id, title, created_at, updated_at")
        .single());

      // If admin_name column doesn't exist yet, retry without it
      if (error && isAdmin && error.message?.includes("admin_name")) {
        ({ data, error } = await supabase
          .from("conversations")
          .insert({ title, invite_code_id: inviteCodeId })
          .select("id, title, created_at, updated_at")
          .single());
      }

      if (!error) break;

      // Retry only on transient network errors
      const msg = error.message ?? "";
      if (
        attempt < MAX_RETRIES &&
        /fetch|network|ECONNR|timeout|socket/i.test(msg)
      ) {
        console.warn(
          `[conversations] Transient DB error (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
          msg
        );
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      break;
    }

    if (error) {
      console.error("DB error:", error.message);
      return serverError(res);
    }

    return res.json(data);
  } catch (err) {
    console.error("[conversations] POST error:", err);
    return serverError(res);
  }
});

// ============================================================
// DELETE /api/conversations — delete conversation(s)
// ============================================================

router.delete("/api/conversations", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return unauthorizedResponse(res);
    }

    let supabase;
    try {
      supabase = createServiceClient();
    } catch (e) {
      console.error("Supabase init error:", e);
      return serverError(res);
    }

    const id = req.query.id as string | undefined;
    const all = req.query.all as string | undefined;
    const adminName = normalizeAdminName(invite.name) || invite.name;

    // Delete all conversations
    if (all === "true") {
      if (isAdminCode(invite.code)) {
        // Админ удаляет только свои диалоги (по admin_name)
        const { data: ownedConvs } = await supabase
          .from("conversations")
          .select("id")
          .eq("admin_name", adminName);

        const ownedIds = (ownedConvs || []).map(
          (c: { id: string }) => c.id
        );
        if (ownedIds.length > 0) {
          await supabase
            .from("messages")
            .delete()
            .in("conversation_id", ownedIds);
          const { error } = await supabase
            .from("conversations")
            .delete()
            .in("id", ownedIds);
          if (error) {
            console.error("DB error:", error.message);
            return serverError(res);
          }
          logAuditEvent({ action: "conversations.delete", adminName, details: { type: "delete_all", count: ownedIds.length } });
        }
      } else {
        // Обычный пользователь удаляет только свои диалоги
        const { data: ownedConvs } = await supabase
          .from("conversations")
          .select("id")
          .eq("invite_code_id", invite.id);

        const ownedIds = (ownedConvs || []).map(
          (c: { id: string }) => c.id
        );
        if (ownedIds.length > 0) {
          await supabase
            .from("messages")
            .delete()
            .in("conversation_id", ownedIds);
          const { error } = await supabase
            .from("conversations")
            .delete()
            .in("id", ownedIds);
          if (error) {
            console.error("DB error:", error.message);
            return serverError(res);
          }
          logAuditEvent({ action: "conversations.delete", adminName, details: { type: "delete_all_user", count: ownedIds.length } });
        }
      }
      return ok(res);
    }

    // Bulk delete by ids in body
    if (!id) {
      const body = req.body;
      if (body && Array.isArray(body.ids) && body.ids.length > 0) {
        let idsToDelete = body.ids;

        // Для обычных пользователей — удаляем только свои диалоги
        if (!isAdminCode(invite.code)) {
          const { data: ownedConvs } = await supabase
            .from("conversations")
            .select("id")
            .in("id", body.ids)
            .eq("invite_code_id", invite.id);

          idsToDelete = (ownedConvs || []).map(
            (c: { id: string }) => c.id
          );
          if (idsToDelete.length === 0) {
            return notFound(res, "Диалоги не найдены");
          }
        }

        await supabase
          .from("messages")
          .delete()
          .in("conversation_id", idsToDelete);
        const { error } = await supabase
          .from("conversations")
          .delete()
          .in("id", idsToDelete);
        if (error) {
          console.error("DB error:", error.message);
          return serverError(res);
        }
        logAuditEvent({ action: "conversations.delete", adminName, details: { type: "bulk", count: idsToDelete.length } });
        return ok(res);
      }

      return res.status(400).json({ error: "id is required" });
    }

    // Проверяем принадлежность диалога (если не админ)
    if (!isAdminCode(invite.code)) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("invite_code_id")
        .eq("id", id)
        .single();

      if (!conv || conv.invite_code_id !== invite.id) {
        return notFound(res, "Диалог не найден");
      }
    }

    // Delete messages first
    await supabase.from("messages").delete().eq("conversation_id", id);
    const { error } = await supabase
      .from("conversations")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("DB error:", error.message);
      return serverError(res);
    }

    logAuditEvent({ action: "conversations.delete", adminName, targetId: id });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[conversations] DELETE error:", err);
    return serverError(res);
  }
});

// ============================================================
// PATCH /api/conversations — rename a conversation
// ============================================================

router.patch("/api/conversations", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return unauthorizedResponse(res);

    let supabase;
    try {
      supabase = createServiceClient();
    } catch (e) {
      console.error("Supabase init error:", e);
      return serverError(res);
    }

    const { id, title } = req.body;
    if (!id || !title || typeof title !== "string") {
      return res.status(400).json({ error: "Missing id or title" });
    }

    // Проверяем принадлежность диалога (если не админ)
    if (!isAdminCode(invite.code)) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("invite_code_id")
        .eq("id", id)
        .single();

      if (!conv || conv.invite_code_id !== invite.id) {
        return notFound(res, "Диалог не найден");
      }
    }

    const { error } = await supabase
      .from("conversations")
      .update({ title: title.trim().slice(0, 200) })
      .eq("id", id);

    if (error) {
      console.error("Rename conversation error:", error.message);
      return serverError(res);
    }

    return ok(res, { ok: true });
  } catch (err) {
    console.error("[conversations] PATCH error:", err);
    return serverError(res);
  }
});

// ============================================================
// GET /api/conversations/messages — get messages for a conversation
// ============================================================

router.get(
  "/api/conversations/messages",
  async (req: Request, res: Response) => {
    try {
      const id = req.query.id as string | undefined;

      if (!id) {
        return res.status(400).json({ error: "id is required" });
      }

      const invite = await getInviteCodeFromHeader(req);
      if (!invite) {
        return unauthorizedResponse(res);
      }

      const supabase = createServiceClient();

      // Проверяем принадлежность диалога (если не админ)
      if (!isAdminCode(invite.code)) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("invite_code_id")
          .eq("id", id)
          .single();

        if (!conv || conv.invite_code_id !== invite.id) {
          return notFound(res, "Диалог не найден");
        }
      }

      const [messagesResult, convResult] = await Promise.all([
        supabase
          .from("messages")
          .select("id, role, content, metadata, created_at")
          .eq("conversation_id", id)
          .order("created_at", { ascending: true }),
        supabase
          .from("conversations")
          .select("id, title, summary")
          .eq("id", id)
          .single(),
      ]);

      if (messagesResult.error) {
        return res
          .status(500)
          .json({ error: "Внутренняя ошибка сервера" });
      }

      return res.json({
        messages: messagesResult.data,
        conversation: convResult.data
          ? {
              ...convResult.data,
              hasSummary: !!convResult.data.summary,
              summary: undefined,
            }
          : null,
      });
    } catch (err) {
      console.error("[conversations/messages] GET error:", err);
      return serverError(res);
    }
  }
);

export default router;
