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
      const storagePath = (req.body.storagePath as string) || null;
      const originalName =
        (req.body.filename as string) || file?.originalname || "unknown";
      const originalMimeType =
        (req.body.mimeType as string) || file?.mimetype || "application/octet-stream";
      const folderPath = (req.body.folderPath as string) || null;
      const storageBucket = (req.body.storageBucket as string) || "documents";

      let buffer: Buffer;
      let filename: string;
      let mimeType: string;

      if (storagePath) {
        // Large file: download from Supabase Storage
        const supabase = createServiceClient();
        const { data, error } = await supabase.storage
          .from(storageBucket)
          .download(storagePath);

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
      return res.status(500).json({ error: "Failed to parse file" });
    }
  }
);

export default router;
