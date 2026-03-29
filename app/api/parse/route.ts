import { NextRequest, NextResponse } from "next/server";
import { parseToMarkdown } from "@/app/lib/parser";
import { autoTag } from "@/app/lib/tagging";
import { chunkMarkdown } from "@/app/lib/chunking";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAuth } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";

export async function POST(req: NextRequest) {
  const authCheck = await requireAuth(req);
  if (authCheck instanceof NextResponse) return authCheck;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const storagePath = formData.get("storagePath") as string | null;
    const originalName = (formData.get("filename") as string) || file?.name || "unknown";
    const originalMimeType = (formData.get("mimeType") as string) || file?.type || "application/octet-stream";
    const folderPath = (formData.get("folderPath") as string) || null;

    let buffer: Buffer;
    let filename: string;
    let mimeType: string;

    if (storagePath) {
      // Large file: download from Supabase Storage
      const supabase = createServiceClient();
      const { data, error } = await supabase.storage
        .from("documents")
        .download(storagePath);

      if (error || !data) {
        console.error("Storage download error:", error);
        return NextResponse.json(
          { error: "Failed to download file from storage" },
          { status: 500 }
        );
      }

      buffer = Buffer.from(await data.arrayBuffer());
      filename = originalName;
      mimeType = originalMimeType;
    } else if (file) {
      const MAX_FILE_SIZE = 50 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json({ error: "Файл слишком большой (макс. 50 МБ)" }, { status: 400 });
      }
      buffer = Buffer.from(await file.arrayBuffer());
      filename = file.name;
      mimeType = file.type;
    } else {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // parseToMarkdown returns { markdown, images }
    const { markdown, images } = await parseToMarkdown(buffer, mimeType, filename);
    const tags = await autoTag(markdown, filename, folderPath);
    const chunks = chunkMarkdown(markdown, images);

    // Serialize images as base64 for transfer to frontend → ingest
    const serializedImages = images.map((img) => ({
      base64: img.data.toString("base64"),
      mimeType: img.mimeType,
      marker: img.marker,
    }));

    return NextResponse.json({
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
    logError({ type: "parse", message: errMsg, endpoint: "/api/parse" }).catch(() => {});
    return NextResponse.json(
      { error: "Failed to parse file" },
      { status: 500 }
    );
  }
}
