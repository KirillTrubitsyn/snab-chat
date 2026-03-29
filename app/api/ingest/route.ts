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

    // Build metadata preamble for each chunk
    const preambleParts: string[] = [`\u{1F4C4} \u0414\u043E\u043A\u0443\u043C\u0435\u043D\u0442: ${filename}`];
    // Extract parent document from filename (text in parentheses at the end)
    const parentMatch = filename.match(/\\(([^)]+)\\)[^)]*$/);
    if (parentMatch) {
      preambleParts.push(`\u{1F4CE} \u0420\u043E\u0434\u0438\u0442\u0435\u043B\u044C\u0441\u043A\u0438\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442: ${parentMatch[1].replace(/_/g, ' ')}`);
    }
    // Extract document type from first tag
    if (tags.length > 0) {
      preambleParts.push(`\u{1F4C2} \u0422\u0438\u043F: ${tags[0]}`);
    }
    // Extract category from second tag
    if (tags.length > 1) {
      preambleParts.push(`\u{1F3F7}\u{FE0F} \u041A\u0430\u0442\u0435\u0433\u043E\u0440\u0438\u044F: ${tags[1]}`);
    }
    // Add folder path if provided
    if (folderPath) {
      preambleParts.push(`\u{1F4C1} \u0420\u0430\u0437\u0434\u0435\u043B: ${folderPath}`);
    }
    const preamble = preambleParts.join(' | ');

    const supabase = createServiceClient();

    // If storagePath was provided (file already uploaded via /api/upload-url), use it.
    // Otherwise, upload the original file to Supabase Storage if provided in form data.
    let storagePath: string | null =
      (formData.get("storagePath") as string) || null;

    if (!storagePath && file) {
      const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json({ error: "\u0424\u0430\u0439\u043B \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439 (\u043C\u0430\u043A\u0441. 50 \u041C\u0411)" }, { status: 400 });
      }
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
        content: `${preamble}\n\n${chunk.content}`,
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
