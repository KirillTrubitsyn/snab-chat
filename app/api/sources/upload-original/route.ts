import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireDocumentAdmin } from "@/app/lib/auth";

/**
 * POST /api/sources/upload-original
 * Загружает оригинальный файл в Supabase Storage и привязывает его
 * к существующей денормализованной source-записи.
 * Принимает multipart/form-data:
 *   - file: бинарный файл
 *   - filename: имя файла для сопоставления с денормализованным источником
 */
export async function POST(req: NextRequest) {
  const adminCheck = requireDocumentAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const filename = (formData.get("filename") as string) || file?.name;

    if (!file || !filename) {
      return NextResponse.json(
        { error: "Missing file or filename" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // Find denormalized source by filename
    const { data: sources, error: findErr } = await supabase
      .from("sources")
      .select("id, filename, mime_type, storage_path")
      .eq("filename", filename)
      .eq("mime_type", "application/x-denormalized");

    if (findErr) {
      return NextResponse.json(
        { error: `DB error: ${findErr.message}` },
        { status: 500 }
      );
    }

    if (!sources || sources.length === 0) {
      return NextResponse.json(
        { error: `No denormalized source found for: ${filename}` },
        { status: 404 }
      );
    }

    const source = sources[0];

    // Determine mime_type from file extension
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
    };
    const newMimeType = mimeMap[ext || ""] || file.type || "application/octet-stream";

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Файл слишком большой (макс. 50 МБ)" }, { status: 400 });
    }

    // Upload to Supabase Storage (use source ID + extension to avoid Cyrillic path issues)
    const storagePath = `originals/${source.id}_${Date.now()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadErr } = await supabase.storage
      .from("documents")
      .upload(storagePath, buffer, {
        contentType: newMimeType,
        upsert: false,
      });

    if (uploadErr) {
      return NextResponse.json(
        { error: `Storage upload error: ${uploadErr.message}` },
        { status: 500 }
      );
    }

    // Update source record
    const { error: updateErr } = await supabase
      .from("sources")
      .update({
        storage_path: storagePath,
        mime_type: newMimeType,
      })
      .eq("id", source.id);

    if (updateErr) {
      return NextResponse.json(
        { error: `DB update error: ${updateErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      source_id: source.id,
      filename,
      storage_path: storagePath,
      mime_type: newMimeType,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
