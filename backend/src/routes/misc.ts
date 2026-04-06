import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { getInviteCodeFromHeader, isAdminCode } from "../lib/auth.js";

const router = Router();

/**
 * GET /api/chunk-image — proxy chunk images from private Supabase Storage.
 * Auth: x-invite-code header OR ?token= query param (for <img src>)
 */
router.get("/api/chunk-image", async (req: Request, res: Response) => {
  try {
    const tokenParam = (req.query.token as string) || "";
    let authorized = false;

    if (tokenParam) {
      const code = decodeURIComponent(tokenParam);
      if (isAdminCode(code)) {
        authorized = true;
      } else {
        const supabase = createServiceClient();
        const { data } = await supabase
          .from("invite_codes")
          .select("id")
          .eq("code", code)
          .eq("is_active", true)
          .single();
        if (data) authorized = true;
      }
    }

    if (!authorized) {
      const invite = await getInviteCodeFromHeader(req);
      if (invite) authorized = true;
    }

    if (!authorized) {
      return res.status(401).send("Unauthorized");
    }

    const path = req.query.path as string;
    if (!path) {
      return res.status(400).send("Missing path parameter");
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase.storage
      .from("chunk-images")
      .download(path);

    if (error || !data) {
      console.error("[chunk-image] Download error:", path, error?.message);
      return res.status(404).send("Image not found");
    }

    const arrayBuffer = await data.arrayBuffer();
    const ext = path.split(".").pop()?.toLowerCase() || "png";
    const mimeType =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "gif"
        ? "image/gif"
        : ext === "webp"
        ? "image/webp"
        : "image/png";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error("[chunk-image] Error:", e);
    return res.status(500).send("Internal error");
  }
});

/**
 * GET /api/debug-chunks — debug chunk retrieval
 */
router.get("/api/debug-chunks", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return res.status(401).json({ error: "Unauthorized" });

    const filename = req.query.filename as string;
    if (!filename) return res.status(400).json({ error: "filename required" });

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("chunks")
      .select("id, source_filename, chunk_index, tags, image_paths")
      .ilike("source_filename", `%${filename}%`)
      .order("chunk_index", { ascending: true })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ chunks: data || [] });
  } catch (err) {
    console.error("[debug-chunks] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
