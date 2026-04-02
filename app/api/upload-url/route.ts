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

    if (!filename) {
      return NextResponse.json(
        { error: "Missing filename" },
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
        { error: `Failed to create upload URL: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      uploadUrl: data.signedUrl,
      storagePath: safeName,
      token: data.token,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
