import { Router, Request, Response } from "express";
import multer from "multer";
import { parseToMarkdown } from "../lib/parser.js";
import { autoTag } from "../lib/tagging.js";
import { chunkMarkdown } from "../lib/chunking.js";
import { createServiceClient } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";
import { logError } from "../lib/error-logger.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// V25 deep-research HIGH-2 fix: bucket allowlists for /api/parse.
// Previously req.body.storageBucket flowed straight into
// supabase.storage.from(...).download(...) under a service-role client,
// allowing any authenticated user to probe arbitrary private buckets if a
// path was known. Restrict to buckets parse legitimately consumes:
//   - chat-uploads — temporary user uploads from the chat sidebar;
//   - documents   — knowledge-base files (admin-only).
const USER_PARSE_BUCKETS = new Set(["chat-uploads"]);
const ADMIN_PARSE_BUCKETS = new Set(["chat-uploads", "documents"]);

/**
 * Reject path traversal and absolute paths. Returns the cleaned path or
 * null if the input is unsafe.
 */
function normalizeStoragePath(p: string): string | null {
  if (!p) return null;
  if (p.includes("..") || p.includes("\\") || p.includes("\u0000")) return null;
  const cleaned = p.replace(/^\/+/, "");
  if (!cleaned) return null;
  return cleaned;
}

// ============================================================
// POST /api/parse — parse uploaded file → markdown + tags + chunks
// ============================================================

router.post(
  "/api/parse",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const authCheck = await requireAuth(req, res);
      if (!authCheck) return;

      const file = req.file ?? null;
      const rawStoragePath = (req.body.storagePath as string) || null;
      const originalName =
        (req.body.filename as string) || file?.originalname || "unknown";
      const originalMimeType =
        (req.body.mimeType as string) || file?.mimetype || "application/octet-stream";
      const folderPath = (req.body.folderPath as string) || null;
      const rawStorageBucket = (req.body.storageBucket as string) || "documents";

      let buffer: Buffer;
      let filename: string;
      let mimeType: string;
      let storagePath: string | null = null;

      if (rawStoragePath) {
        // V25 deep-research HIGH-2 fix: validate bucket against an allowlist
        // scoped by caller role, and reject path-traversal / absolute paths
        // before handing the input to a service-role storage client.
        const allowed = authCheck.isAdmin ? ADMIN_PARSE_BUCKETS : USER_PARSE_BUCKETS;
        if (!allowed.has(rawStorageBucket)) {
          return res.status(400).json({ error: "Storage bucket not allowed" });
        }
        const cleaned = normalizeStoragePath(rawStoragePath);
        if (!cleaned) {
          return res.status(400).json({ error: "Invalid storagePath" });
        }
        storagePath = cleaned;

        // Large file: download from Supabase Storage
        const supabase = createServiceClient();
        const { data, error } = await supabase.storage
          .from(rawStorageBucket)
          .download(cleaned);

        if (error || !data) {
          console.error("Storage download error:", error);
          return res
            .status(500)
            .json({ error: "Failed to download file from storage" });
        }

        buffer = Buffer.from(await data.arrayBuffer());
        filename = originalName;
        mimeType = originalMimeType;
      } else if (file) {
        buffer = file.buffer;
        filename = file.originalname;
        mimeType = file.mimetype;
      } else {
        return res.status(400).json({ error: "No file provided" });
      }

      // parseToMarkdown returns { markdown, images }
      const { markdown, images } = await parseToMarkdown(
        buffer,
        mimeType,
        filename
      );
      const tags = await autoTag(markdown, filename, folderPath);
      const chunks = chunkMarkdown(markdown, images);

      // Serialize images as base64 for transfer to frontend → ingest
      const serializedImages = images.map((img) => ({
        base64: img.data.toString("base64"),
        mimeType: img.mimeType,
        marker: img.marker,
      }));

      return res.json({
        filename,
        mimeType,
        markdown,
        tags,
        images: serializedImages,
        // If file was uploaded via presigned URL, pass storagePath through
        // so ingest can reuse it instead of re-uploading
        ...(storagePath ? { storagePath } : {}),
        chunks: chunks.map((c) => ({
          index: c.index,
          preview: c.content.slice(0, 200),
          length: c.content.length,
          imageCount: c.images.length,
        })),
        totalChunks: chunks.length,
        totalImages: images.length,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Parse error:", err);
      logError({
        type: "parse",
        message: errMsg,
        endpoint: "/api/parse",
      }).catch(() => {});
      return res.status(500).json({ error: "Ошибка при обработке файла" });
    }
  }
);

export default router;
