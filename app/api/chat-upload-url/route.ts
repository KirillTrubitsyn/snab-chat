import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAuth } from "@/app/lib/auth";

/**
 * POST /api/chat-upload-url
 *
 * Создаёт signed upload URL для загрузки больших файлов в чате
 * (аудио, документы >4MB) напрямую в Supabase Storage,
 * минуя лимит Vercel в 4.5 МБ.
 *
 * Доступен всем авторизованным пользователям (не только админам).
 * Файлы загружаются во временный бакет chat-uploads.
 */

let bucketReady = false;

export async function POST(req: NextRequest) {
  const authCheck = await requireAuth(req);
  if (authCheck instanceof NextResponse) return authCheck;

  try {
    const { filename, mimeType } = await req.json();

    if (!filename) {
      return NextResponse.json(
        { error: "Missing filename" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    if (!bucketReady) {
      await supabase.storage
        .createBucket("chat-uploads", { public: false })
        .catch(() => {});
      bucketReady = true;
    }

    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const { data, error } = await supabase.storage
      .from("chat-uploads")
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
