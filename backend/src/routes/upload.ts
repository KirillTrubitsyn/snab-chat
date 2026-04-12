import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { requireDocumentAdmin, requireAuth } from "../lib/auth.js";

const router = Router();

// Allowed file extensions for document upload
const ALLOWED_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "txt", "csv", "rtf", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp",
  "mp3", "wav", "ogg", "m4a", "webm",
]);

function isAllowedFileType(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ALLOWED_EXTENSIONS.has(ext);
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/upload-url
//
// Создаёт signed upload URL для загрузки больших файлов напрямую
// в Supabase Storage, минуя лимит в 4.5 МБ.
// Доступен только document-админам.
// ────────────────────────────────────────────────────────────────────────────

let documentsBucketReady = false;

router.post("/api/upload-url", async (req: Request, res: Response) => {
  try {
    const admin = requireDocumentAdmin(req, res);
    if (!admin) return;

    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: "Missing filename" });
    }

    if (!isAllowedFileType(filename)) {
      return res.status(400).json({ error: "File type not allowed. Supported: PDF, DOCX, XLSX, PPTX, images, audio." });
    }

    const supabase = createServiceClient();

    // Ensure bucket exists
    if (!documentsBucketReady) {
      await supabase.storage
        .createBucket("documents", { public: false })
        .catch(() => {});
      documentsBucketReady = true;
    }

    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUploadUrl(safeName);

    if (error) {
      console.error("Signed URL error:", error);
      return res.status(500).json({ error: "Не удалось создать URL для загрузки" });
    }

    return res.json({
      uploadUrl: data.signedUrl,
      storagePath: safeName,
      token: data.token,
    });
  } catch (err) {
    console.error("Upload URL error:", err);
    return res.status(500).json({ error: "Ошибка при создании URL для загрузки" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/chat-upload-url
//
// Создаёт signed upload URL для загрузки больших файлов в чате
// (аудио, документы >4MB) напрямую в Supabase Storage.
// Доступен всем авторизованным пользователям (не только админам).
// ────────────────────────────────────────────────────────────────────────────

let chatBucketReady = false;

router.post("/api/chat-upload-url", async (req: Request, res: Response) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: "Missing filename" });
    }

    if (!isAllowedFileType(filename)) {
      return res.status(400).json({ error: "File type not allowed. Supported: PDF, DOCX, XLSX, PPTX, images, audio." });
    }

    const supabase = createServiceClient();

    if (!chatBucketReady) {
      await supabase.storage
        .createBucket("chat-uploads", { public: false })
        .catch(() => {});
      chatBucketReady = true;
    }

    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const { data, error } = await supabase.storage
      .from("chat-uploads")
      .createSignedUploadUrl(safeName);

    if (error) {
      console.error("Chat signed URL error:", error);
      return res.status(500).json({ error: "Не удалось создать URL для загрузки" });
    }

    return res.json({
      uploadUrl: data.signedUrl,
      storagePath: safeName,
      token: data.token,
    });
  } catch (err) {
    console.error("Chat upload URL error:", err);
    return res.status(500).json({ error: "Ошибка при создании URL для загрузки" });
  }
});

export default router;
