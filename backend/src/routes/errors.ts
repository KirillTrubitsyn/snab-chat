import { Router, Request, Response } from "express";
import { getInviteCodeFromHeader } from "../lib/auth.js";
import { logError } from "../lib/error-logger.js";
import { errorLogSchema, parseBody } from "../lib/validation.js";

const router = Router();

router.post("/api/errors", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return res.status(401).json({ error: "Unauthorized" });

    const parsed = parseBody(req.body, errorLogSchema, res);
    if (parsed.error) return;

    await logError({
      type: parsed.data.error_type ?? "client",
      message: parsed.data.error_message,
      endpoint: parsed.data.endpoint,
      userName: invite.name,
      organization: invite.organization ?? null,
      inviteCodeId: invite.id,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/errors error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export default router;
