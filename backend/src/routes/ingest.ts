import { Router, Request, Response } from "express";
import multer from "multer";
import { createServiceClient } from "../lib/supabase.js";
import { chunkMarkdown } from "../lib/chunking.js";
import { embedDocuments, embedTexts } from "../lib/embeddings.js";
import { requireDocumentAdmin } from "../lib/auth.js";
import { logError } from "../lib/error-logger.js";
import { parseToMarkdown } from "../lib/parser.js";
import type { ExtractedImage } from "../lib/parser.js";
import {
  parseRelationshipHints,
  resolveParentByHint,
} from "../lib/relationships.js";
import type { DocumentRelationship } from "../lib/relationships.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

let bucketReady = false;
let imageBucketReady = false;

// ============================================================
// POST /api/ingest — ingest a parsed document (embed + store)
// ============================================================

router.post(
  "/api/ingest",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const adminCheck = requireDocumentAdmin(req, res);
      if (!adminCheck) return;

      const file = req.file ?? null;
      const filename = req.body.filename as string;
      const mimeType = req.body.mimeType as string;
      const markdown = req.body.markdown as string;
      const tagsRaw = req.body.tags as string;
      const tags: string[] = tagsRaw
        ? (JSON.parse(tagsRaw) as string[]).map((t) => t.toLowerCase())
        : [];
      const folderPath = (req.body.folderPath as string) || null;

      const supabase = createServiceClient();

      // Extract images: either from FormData (small files) or by re-parsing from Storage (large files)
      let images: ExtractedImage[] = [];
      const imagesRaw = (req.body.images as string) || null;
      const incomingStoragePath = (req.body.storagePath as string) || null;

      if (imagesRaw) {
        // Small file: images sent directly as base64
        images = (
          JSON.parse(imagesRaw) as Array<{
            base64: string;
            mimeType: string;
            marker: string;
          }>
        ).map((img) => ({
          data: Buffer.from(img.base64, "base64"),
          mimeType: img.mimeType,
          marker: img.marker,
        }));
      } else if (incomingStoragePath) {
        // Large file: re-extract images from the file already in Storage
        try {
          const { data: fileData, error: dlError } = await supabase.storage
            .from("documents")
            .download(incomingStoragePath);

          if (!dlError && fileData) {
            const buffer = Buffer.from(await fileData.arrayBuffer());
            const parsed = await parseToMarkdown(buffer, mimeType, filename);
            images = parsed.images;
            console.log(
              `[ingest] Re-extracted ${images.length} images from Storage for ${filename}`
            );
          }
        } catch (e) {
          console.error(
            "[ingest] Failed to re-extract images from Storage:",
            e
          );
        }
      }

      // Build metadata preamble for each chunk
      const preambleParts: string[] = [`Документ: ${filename}`];
      const parentMatch = filename.match(/\(([^)]+)\)[^)]*$/);
      if (parentMatch) {
        preambleParts.push(
          `Родительский документ: ${parentMatch[1].replace(/_/g, " ")}`
        );
      }
      if (tags.length > 0) {
        preambleParts.push(`Тип: ${tags[0]}`);
      }
      if (tags.length > 1) {
        preambleParts.push(`Категория: ${tags[1]}`);
      }
      if (folderPath) {
        preambleParts.push(`Раздел: ${folderPath}`);
      }
      const preamble = preambleParts.join(" | ");

      // Upload original file to Storage (reuse storagePath from parse if available)
      let storagePath: string | null = incomingStoragePath;

      if (!storagePath && file) {
        const buffer = file.buffer;
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

      // Parse document relationships from metadata headers
      const { parentHint, type: relType } = parseRelationshipHints(
        markdown,
        filename
      );
      let relationships: DocumentRelationship | null = null;

      if (parentHint) {
        const parentId = await resolveParentByHint(parentHint);
        relationships = {
          parent_hint: parentHint,
          ...(parentId ? { parent_id: parentId } : {}),
          ...(relType ? { type: relType } : {}),
        };
        console.log(
          `[ingest] Relationship detected: "${filename}" → parent hint "${parentHint}" (resolved ID: ${parentId ?? "none"})`
        );
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
          ...(relationships ? { relationships } : {}),
        })
        .select("id")
        .single();

      if (sourceError) {
        console.error("Source insert error:", sourceError);
        return res.status(500).json({ error: "Failed to create source" });
      }

      // Bidirectional linking: update parent's children_ids to include this new source
      if (relationships?.parent_id && source.id) {
        try {
          const { data: parentSource } = await supabase
            .from("sources")
            .select("relationships")
            .eq("id", relationships.parent_id)
            .single();

          if (parentSource) {
            const parentRel =
              (parentSource.relationships as DocumentRelationship) || {};
            const childrenIds = parentRel.children_ids || [];
            if (!childrenIds.includes(source.id)) {
              childrenIds.push(source.id);
              await supabase
                .from("sources")
                .update({
                  relationships: { ...parentRel, children_ids: childrenIds },
                })
                .eq("id", relationships.parent_id);
              console.log(
                `[ingest] Updated parent ${relationships.parent_id} with child ${source.id}`
              );
            }
          }
        } catch (e) {
          console.error("[ingest] Failed to update parent relationship:", e);
        }
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

        // Text-only embeddings for retrieval accuracy.
        const embedInputs = batch.map((c) => ({
          text: c.content,
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

        const { error: chunkError } = await supabase
          .from("chunks")
          .insert(rows);

        if (chunkError) {
          console.error("Chunk insert error:", chunkError);
          return res.status(500).json({
            error: `Failed to insert chunk batch starting at ${i}`,
          });
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

      return res.json({
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
      return res.status(500).json({ error: "Failed to ingest document" });
    }
  }
);

// ============================================================
// Ingest JSONL helpers
// ============================================================

interface JsonlStatement {
  id?: string;
  source_document: string;
  source_file: string;
  section: string;
  table_type?: string;
  table_name?: string;
  text: string;
  keywords?: string[];
  /** Ключ Parent-Child группировки. Если не указан, генерируется автоматически. */
  parent_group_key?: string;
}

function sectionToTags(section: string, tableType?: string): string[] {
  const tags: string[] = [];
  if (section.includes("Законодательство")) tags.push("законодательство");
  else if (section.includes("Положения")) tags.push("положения");
  else if (section.includes("223-ФЗ")) tags.push("223-ФЗ", "стандарт");
  else if (section.includes("вне 223-ФЗ")) tags.push("вне 223-ФЗ", "стандарт");
  else if (section.includes("планирования")) tags.push("планирование");
  else if (section.includes("СМР") || section.includes("ПИР"))
    tags.push("СМР", "ПИР");
  else if (section.includes("Ценообразование")) tags.push("ценообразование");
  else if (section.includes("Договоры")) tags.push("договоры");
  else if (section.includes("Инструкции")) tags.push("инструкции");
  else if (section.includes("Методические")) tags.push("методика");
  else if (section.includes("Справочники")) tags.push("справочники");
  if (tableType === "decision_matrix") tags.push("матрица полномочий");
  else if (tableType === "registry") tags.push("реестр");
  else if (tableType === "numeric") tags.push("числовые данные");
  else if (tableType === "form") tags.push("форма");
  else if (tableType === "reference") tags.push("справочник");
  else if (tableType === "comparison") tags.push("сравнение");
  tags.push("денормализовано");
  return tags;
}

function normalizeKeyPart(str: string, maxLen: number): string {
  return str
    .replace(/\s+/g, "_")
    .replace(/[«»""]/g, "")
    .replace(/[^а-яА-ЯёЁa-zA-Z0-9_\-]/g, "")
    .substring(0, maxLen);
}

function generateParentGroupKey(stmt: JsonlStatement): string {
  const fileKey = normalizeKeyPart(
    stmt.source_file.replace(/\.\w+$/, ""),
    60
  );

  const tableKey = stmt.table_name
    ? normalizeKeyPart(stmt.table_name, 40)
    : stmt.table_type ?? "общий";

  return `${fileKey}::${tableKey}`;
}

// ============================================================
// POST /api/ingest-jsonl — batch ingest denormalized statements
// ============================================================

router.post("/api/ingest-jsonl", async (req: Request, res: Response) => {
  try {
    const adminCheck = requireDocumentAdmin(req, res);
    if (!adminCheck) return;

    const body = req.body;
    const statements: JsonlStatement[] = body.statements ?? [];
    let sourceId: string | null = body.sourceId ?? null;
    const chunkOffset: number = body.chunkOffset ?? 0;
    const originalFilename: string | null = body.original_filename ?? null;
    const originalFileUrl: string | null = body.original_file_url ?? null;

    if (statements.length === 0) {
      return res.status(400).json({ error: "Empty statements array" });
    }

    if (statements.length > 30) {
      return res.status(400).json({
        error: "Max 30 statements per batch. Use smaller batches.",
      });
    }

    const supabase = createServiceClient();
    const firstStmt = statements[0];
    const tags = sectionToTags(firstStmt.section, firstStmt.table_type);

    // Create source if not provided
    if (!sourceId) {
      const sourceRow: Record<string, unknown> = {
        filename: firstStmt.source_file,
        mime_type: "application/x-denormalized",
        tags,
        content_preview: `Денормализовано: ${firstStmt.source_document}`,
        folder_path: firstStmt.section,
      };

      // Добавляем original_filename и original_file_url, если переданы
      if (originalFilename) {
        sourceRow.original_filename = originalFilename;
      }
      if (originalFileUrl) {
        sourceRow.original_file_url = originalFileUrl;
      }

      const { data: source, error: srcErr } = await supabase
        .from("sources")
        .insert(sourceRow)
        .select("id")
        .single();

      if (srcErr || !source) {
        return res.status(500).json({
          error: `Source create failed: ${srcErr?.message}`,
        });
      }
      sourceId = source.id;
    }

    // Embed all texts in batch
    const texts = statements.map((s) => s.text);
    const embeddings = await embedTexts(texts);

    // Build rows with parent_group_key
    const rows = statements
      .map((stmt, j) => {
        if (!embeddings[j] || embeddings[j].length === 0) return null;

        const parentGroupKey =
          stmt.parent_group_key ?? generateParentGroupKey(stmt);

        return {
          source_id: sourceId,
          source_filename: stmt.source_file,
          chunk_index: chunkOffset + j,
          content: stmt.text,
          embedding: JSON.stringify(embeddings[j]),
          tags: sectionToTags(stmt.section, stmt.table_type),
          parent_group_key: parentGroupKey,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    let inserted = 0;
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("chunks").insert(rows);
      if (insErr) {
        return res.status(500).json({
          error: `Insert failed: ${insErr.message}`,
        });
      }
      inserted = rows.length;
    }

    return res.json({ sourceId, inserted, total: statements.length });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Ingest JSONL error:", err);
    logError({
      type: "ingest-jsonl",
      message: errMsg,
      endpoint: "/api/ingest-jsonl",
    }).catch(() => {});
    return res.status(500).json({ error: errMsg });
  }
});

// ============================================================
// DELETE /api/ingest-jsonl — delete all denormalized data
// ============================================================

router.delete("/api/ingest-jsonl", async (req: Request, res: Response) => {
  try {
    const adminCheck = requireDocumentAdmin(req, res);
    if (!adminCheck) return;

    const supabase = createServiceClient();

    const { error: delChunks, count: chunksDeleted } = await supabase
      .from("chunks")
      .delete({ count: "exact" })
      .contains("tags", ["денормализовано"]);

    const { error: delSources, count: sourcesDeleted } = await supabase
      .from("sources")
      .delete({ count: "exact" })
      .eq("mime_type", "application/x-denormalized");

    return res.json({
      success: !delChunks && !delSources,
      chunksDeleted,
      sourcesDeleted,
      errors: [delChunks?.message, delSources?.message].filter(Boolean),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Delete JSONL error:", err);
    return res.status(500).json({ error: errMsg });
  }
});

export default router;
