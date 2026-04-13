import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { getInviteCodeFromHeader } from "../lib/auth.js";
import { updateAdminPresence } from "../lib/admin-presence.js";

const router = Router();

/**
 * POST /api/heartbeat
 * Updates last_seen_at for the user's device.
 * Headers: x-invite-code, x-device-id (optional)
 */
router.post("/api/heartbeat", async (req: Request, res: Response) => {
  try {
    const deviceId = (req.headers["x-device-id"] as string) ?? "";

    // R4 fix: use getInviteCodeFromHeader to enforce password check on protected codes
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return res.status(401).json({ error: "Invalid code" });
    }

    // Admin codes have synthetic IDs ("admin-...") with no real device rows.
    // Track their presence in memory instead.
    if (invite.id.startsWith("admin-")) {
      updateAdminPresence(invite.code, invite.name);
      return res.json({ ok: true });
    }

    const supabase = createServiceClient();
    const now = new Date().toISOString();

    // Update last_seen_at for the specific device or all devices of this user
    if (deviceId) {
      const { data: updated } = await supabase
        .from("devices")
        .update({ last_seen_at: now })
        .eq("invite_code_id", invite.id)
        .eq("device_id", deviceId)
        .select("id");

      // Device was deleted by admin → signal forced logout
      if (!updated || updated.length === 0) {
        return res.json({ ok: false, logout: true });
      }
    } else {
      await supabase
        .from("devices")
        .update({ last_seen_at: now })
        .eq("invite_code_id", invite.id);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/heartbeat error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
