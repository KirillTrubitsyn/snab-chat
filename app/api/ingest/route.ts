import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { chunkMarkdown } from "@/app/lib/chunking";
import { embedDocuments } from "@/app/lib/embeddings";
import { requireAdmin } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";
import type { ExtractedImage } from "@/app/lib/parser";

let bucketReady = false;
let imageBucketReady = false;

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

    // Parse images from formData (sent as JSON array of {base64, mimeType, marker})
    const imagesRaw = formData.get("images") as string | null;
    const images: ExtractedImage[] = imagesRaw
      ? (JSON.parse(imagesRaw) as Array<{ base64: string; mimeType: string; marker: string }>).map(
          (img) => ({
            data: Buffer.from(img.base64, "base64"),
            mimeType: img.mimeType,
            marker: img.marker,
          })
        )
      : [];

    // Build metadata preamble for each chunk
    const preambleParts: string[] = [`📄 Документ: ${filename}`];
    const parentMatch = filename.match(/\(([^)]+)\)[^)]*$/);
    if (parentMatch) {
      preambleParts.push(
        `📎 Родительский документ: ${parentMatch[1].replace(/_/g, " ")}`
      );
    }
    if (tags.length > 0) {
      preambleParts.push(`📂 Тип: ${tags[0]}`);
    }
    if (tags.length > 1) {
      preambleParts.push(`🏷️ Категория: ${tags[1]}`);
    }
    if (folderPath) {
      preambleParts.push(`📁 Раздел: ${folderPath}`);
    }
    const preamble = preambleParts.join(" | ");

    const supabase = createServiceClient();

    // Upload original file to Storage
    let storagePath: string | null =
      (formData.get("storagePath") as string) || null;

    if (!storagePath && file) {
      const MAX_FILE_SIZE = 50 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: "Файл слишком большой (макс. 50 МБ)" },
          { status: 400 }
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      storagePath = safeName;

      if (!bucketReady) {
        await supabase.storage
          .createBucket("documents", { public: false })
          .catch(() => {});
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

    // Ensure chunk-images bucket exists
    if (images.length > 0 && !imageBucketReady) {
      await supabase.storage
        .createBucket("chunk-images", { public: false })
        .catch(() => {});
      imageBucketReady = true;
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

    // Chunk with images
    const chunks = chunkMarkdown(markdown, images);

    // Upload chunk images to Storage and collect paths
    const chunkImagePaths: Map<number, string[]> = new Map();

    for (const chunk of chunks) {
      if (chunk.images.length === 0) continue;

      const paths: string[] = [];
      for (let imgIdx = 0; imgIdx < chunk.images.length; imgIdx++) {
        const img = chunk.images[imgIdx];
        const ext = img.mimeType.split("/")[1] || "png";
        const imgPath = `${source.id}/chunk_${chunk.index}_img_${imgIdx}.${ext}`;

        const { error: imgUploadError } = await supabase.storage
          .from("chunk-images")
          .upload(imgPath, img.data, {
            contentType: img.mimeType,
            upsert: true,
          });

        if (imgUploadError) {
          console.error(
            `Image upload error (chunk ${chunk.index}, img ${imgIdx}):`,
            imgUploadError
          );
        } else {
          paths.push(imgPath);
        }
      }
      chunkImagePaths.set(chunk.index, paths);
    }

    // Embed in batches with multimodal content
    const batchSize = 50;
    let insertedCount = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      // Build embedding inputs: text + images for multimodal embedding
      const embedInputs = batch.map((c) => ({
        text: c.content,
        images: c.images,
      }));

      const embeddings = await embedDocuments(embedInputs);

      const rows = batch.map((chunk, j) => ({
        source_id: source.id,
        source_filename: filename,
        chunk_index: chunk.index,
        content: `${preamble}\n\n${chunk.content}`,
        embedding: JSON.stringify(embeddings[j]),
        tags,
        image_paths: chunkImagePaths.get(chunk.index) || [],
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

    const totalImages = Array.from(chunkImagePaths.values()).reduce(
      (sum, paths) => sum + paths.length,
      0
    );

    console.log(
      `[ingest] ${filename}: ${insertedCount} chunks, ${totalImages} images uploaded`
    );

    return NextResponse.json({
      sourceId: source.id,
      chunksInserted: insertedCount,
      imagesUploaded: totalImages,
      filename,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Ingest error:", err);
    logError({
      type: "ingest",
      message: errMsg,
      endpoint: "/api/ingest",
    }).catch(() => {});
    return NextResponse.json(
      { error: "Failed to ingest document" },
      { status: 500 }
    );
  }
}
