import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { chunkMarkdown } from "@/app/lib/chunking";
import { embedDocuments } from "@/app/lib/embeddings";
import { requireAdmin } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";

let bucketReady = false;

export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const filename = formData.get("filename") as string;
    const mimeType = formData.get("mimeType") as string;
    const markdown = formData.get("markdown") as string;
    const tagsRaw = formData.get("tags") as string;
    const tags: string[] = tagsRaw ? JSON.parse(tagsRaw) : [];
    const folderPath = (formData.get("folderPath") as string) || null;

    const supabase = createServiceClient();

    // Upload original file to Supabase Storage if provided
    let storagePath: string | null = null;
    if (file) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      storagePath = safeName;

      // Ensure bucket exists only once per server lifetime
      if (!bucketReady) {
        await supabase.storage.createBucket("documents", { public: false }).catch(() => {});
        bucketReady = true;
      }

      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(storagePath, buffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        console.error("Storage upload error:", uploadError);
        storagePath = null;
      }
    }

    // Create source entry
    const { data: source, error: sourceError } = await supabase
      .from("sources")
      .insert({
        filename,
        mime_type: mimeType,
        tags,
        content_preview: markdown.slice(0, 500),
        storage_path: storagePath,
        folder_path: folderPath,
      })
      .select("id")
      .single();

    if (sourceError) {
      console.error("Source insert error:", sourceError);
      return NextResponse.json(
        { error: "Failed to create source" },
        { status: 500 }
      );
    }

    const chunks = chunkMarkdown(markdown);

    // Embed in batches (single API call per batch)
    const batchSize = 50;
    let insertedCount = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await embedDocuments(texts);

      const rows = batch.map((chunk, j) => ({
        source_id: source.id,
        source_filename: filename,
        chunk_index: chunk.index,
        content: chunk.content,
        embedding: JSON.stringify(embeddings[j]),
        tags,
      }));

      const { error: chunkError } = await supabase.from("chunks").insert(rows);

      if (chunkError) {
        console.error("Chunk insert error:", chunkError);
        return NextResponse.json(
          { error: `Failed to insert chunk batch starting at ${i}` },
          { status: 500 }
        );
      }

      insertedCount += batch.length;
    }

    return NextResponse.json({
      sourceId: source.id,
      chunksInserted: insertedCount,
      filename,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Ingest error:", err);
    logError({ type: "ingest", message: errMsg, endpoint: "/api/ingest" }).catch(() => {});
    return NextResponse.json(
      { error: "Failed to ingest document" },
      { status: 500 }
    );
  }
}
