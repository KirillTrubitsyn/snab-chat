import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";

const router = Router();

/**
 * POST /api/heartbeat
 * Updates last_seen_at for the user's device.
 * Headers: x-invite-code, x-device-id (optional)
 */
router.post("/api/heartbeat", async (req: Request, res: Response) => {
  try {
    const rawCode = decodeURIComponent((req.headers["x-invite-code"] as string) ?? "");
    const deviceId = (req.headers["x-device-id"] as string) ?? "";

    if (!rawCode) {
      return res.status(400).json({ error: "Missing invite code" });
    }

    const supabase = createServiceClient();
    const now = new Date().toISOString();

    // Look up invite_code_id
    const { data: invite } = await supabase
      .from("invite_codes")
      .select("id")
      .eq("code", rawCode.toUpperCase())
      .eq("is_active", true)
      .single();

    if (!invite) {
      return res.status(401).json({ error: "Invalid code" });
    }

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
