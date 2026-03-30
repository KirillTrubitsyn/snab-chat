import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { embedTexts } from "@/app/lib/embeddings";
import { requireAdmin } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";

/**
 * POST /api/ingest-jsonl — батчевая загрузка денормализованных утверждений.
 *
 * Принимает JSON body (НЕ formData), чтобы работать из browser console.
 * Батч по 15-20 утверждений за вызов (укладывается в таймаут Vercel).
 *
 * Body: {
 *   statements: Array<{ text, source_file, source_document, section, table_type? }>,
 *   sourceId?: string,     // передаём при повторных вызовах для того же source_file
 *   chunkOffset?: number   // смещение индекса чанка
 * }
 *
 * Response: { sourceId, inserted, total }
 */

interface JsonlStatement {
  id?: string;
  source_document: string;
  source_file: string;
  section: string;
  table_type?: string;
  table_name?: string;
  text: string;
  keywords?: string[];
}

function sectionToTags(section: string, tableType?: string): string[] {
  const tags: string[] = [];
  if (section.includes("Законодательство")) tags.push("законодательство");
  else if (section.includes("Положения")) tags.push("положения");
  else if (section.includes("223-ФЗ")) tags.push("223-ФЗ", "стандарт");
  else if (section.includes("вне 223-ФЗ")) tags.push("вне 223-ФЗ", "стандарт");
  else if (section.includes("планирования")) tags.push("планирование");
  else if (section.includes("СМР") || section.includes("ПИР")) tags.push("СМР", "ПИР");
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
  tags.push("денормализовано");
  return tags;
}

export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const body = await req.json();
    const statements: JsonlStatement[] = body.statements ?? [];
    let sourceId: string | null = body.sourceId ?? null;
    const chunkOffset: number = body.chunkOffset ?? 0;

    if (statements.length === 0) {
      return NextResponse.json({ error: "Empty statements array" }, { status: 400 });
    }

    if (statements.length > 30) {
      return NextResponse.json(
        { error: "Max 30 statements per batch. Use smaller batches." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const firstStmt = statements[0];
    const tags = sectionToTags(firstStmt.section, firstStmt.table_type);

    // Create source if not provided
    if (!sourceId) {
      const { data: source, error: srcErr } = await supabase
        .from("sources")
        .insert({
          filename: firstStmt.source_file,
          mime_type: "application/x-denormalized",
          tags,
          content_preview: `Денормализовано: ${firstStmt.source_document}`,
          folder_path: firstStmt.section,
        })
        .select("id")
        .single();

      if (srcErr || !source) {
        return NextResponse.json(
          { error: `Source create failed: ${srcErr?.message}` },
          { status: 500 }
        );
      }
      sourceId = source.id;
    }

    // Embed all texts in batch
    const texts = statements.map((s) => s.text);
    const embeddings = await embedTexts(texts);

    // Build rows
    const rows = statements
      .map((stmt, j) => {
        if (!embeddings[j] || embeddings[j].length === 0) return null;
        return {
          source_id: sourceId,
          source_filename: stmt.source_file,
          chunk_index: chunkOffset + j,
          content: stmt.text,
          embedding: JSON.stringify(embeddings[j]),
          tags: sectionToTags(stmt.section, stmt.table_type),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    let inserted = 0;
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("chunks").insert(rows);
      if (insErr) {
        return NextResponse.json(
          { error: `Insert failed: ${insErr.message}` },
          { status: 500 }
        );
      }
      inserted = rows.length;
    }

    return NextResponse.json({ sourceId, inserted, total: statements.length });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Ingest JSONL error:", err);
    logError({
      type: "ingest-jsonl",
      message: errMsg,
      endpoint: "/api/ingest-jsonl",
    }).catch(() => {});
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}

/**
 * DELETE /api/ingest-jsonl — удаляет все денормализованные данные.
 */
export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();

  const { error: delChunks, count: chunksDeleted } = await supabase
    .from("chunks")
    .delete({ count: "exact" })
    .contains("tags", ["денормализовано"]);

  const { error: delSources, count: sourcesDeleted } = await supabase
    .from("sources")
    .delete({ count: "exact" })
    .eq("mime_type", "application/x-denormalized");

  return NextResponse.json({
    success: !delChunks && !delSources,
    chunksDeleted,
    sourcesDeleted,
    errors: [delChunks?.message, delSources?.message].filter(Boolean),
  });
}
