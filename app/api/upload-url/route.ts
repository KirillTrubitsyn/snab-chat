import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireDocumentAdmin } from "@/app/lib/auth";

/**
 * POST /api/upload-url
 *
 * Создаёт signed upload URL для загрузки больших файлов напрямую
 * в Supabase Storage, минуя лимит Vercel в 4.5 МБ.
 *
 * Принимает JSON: { filename: string, mimeType: string }
 * Возвращает: { uploadUrl: string, storagePath: string, token: string }
 *
 * Клиент загружает файл PUT-запросом на uploadUrl,
 * затем передаёт storagePath в /api/ingest.
 */

let bucketReady = false;

export async function POST(req: NextRequest) {
  const adminCheck = requireDocumentAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const { filename, mimeType } = await req.json();

    const ALLOWED_MIME_TYPES = new Set([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/plain",
      "text/csv",
      "text/markdown",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);

    if (!filename) {
      return NextResponse.json(
        { error: "Missing filename" },
        { status: 400 }
      );
    }

    if (mimeType && typeof mimeType === "string" && !ALLOWED_MIME_TYPES.has(mimeType)) {
      return NextResponse.json(
        { error: "Неподдерживаемый MIME-тип" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // Ensure bucket exists
    if (!bucketReady) {
      await supabase.storage
        .createBucket("documents", { public: false })
        .catch(() => {});
      bucketReady = true;
    }

    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUploadUrl(safeName);

    if (error) {
      console.error("Signed URL error:", error);
      return NextResponse.json(
        { error: "Не удалось создать URL загрузки" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      uploadUrl: data.signedUrl,
      storagePath: safeName,
      token: data.token,
    });
  } catch (err) {
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
