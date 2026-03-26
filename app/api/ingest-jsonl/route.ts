import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { embedDocuments } from "@/app/lib/embeddings";
import { requireAdmin } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";

/**
 * POST /api/ingest-jsonl â Ð±Ð°ÑÑÐµÐ²Ð°Ñ Ð·Ð°Ð³ÑÑÐ·ÐºÐ° Ð´ÐµÐ½Ð¾ÑÐ¼Ð°Ð»Ð¸Ð·Ð¾Ð²Ð°Ð½Ð½ÑÑ ÑÑÐ²ÐµÑÐ¶Ð´ÐµÐ½Ð¸Ð¹.
 *
 * ÐÑÐ¸Ð½Ð¸Ð¼Ð°ÐµÑ JSON body (ÐÐ formData), ÑÑÐ¾Ð±Ñ ÑÐ°Ð±Ð¾ÑÐ°ÑÑ Ð¸Ð· browser console.
 * ÐÐ°ÑÑ Ð¿Ð¾ 15-20 ÑÑÐ²ÐµÑÐ¶Ð´ÐµÐ½Ð¸Ð¹ Ð·Ð° Ð²ÑÐ·Ð¾Ð² (ÑÐºÐ»Ð°Ð´ÑÐ²Ð°ÐµÑÑÑ Ð² ÑÐ°Ð¹Ð¼Ð°ÑÑ Vercel).
 *
 * Body: {
 *   statements: Array<{ text, source_file, source_document, section, table_type? }>,
 *   sourceId?: string,     // Ð¿ÐµÑÐµÐ´Ð°ÑÐ¼ Ð¿ÑÐ¸ Ð¿Ð¾Ð²ÑÐ¾ÑÐ½ÑÑ Ð²ÑÐ·Ð¾Ð²Ð°Ñ Ð´Ð»Ñ ÑÐ¾Ð³Ð¾ Ð¶Ðµ source_file
 *   chunkOffset?: number   // ÑÐ¼ÐµÑÐµÐ½Ð¸Ðµ Ð¸Ð½Ð´ÐµÐºÑÐ° ÑÐ°Ð½ÐºÐ°
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
  if (section.includes("ÐÐ°ÐºÐ¾Ð½Ð¾Ð´Ð°ÑÐµÐ»ÑÑÑÐ²Ð¾")) tags.push("Ð·Ð°ÐºÐ¾Ð½Ð¾Ð´Ð°ÑÐµÐ»ÑÑÑÐ²Ð¾");
  else if (section.includes("ÐÐ¾Ð»Ð¾Ð¶ÐµÐ½Ð¸Ñ")) tags.push("Ð¿Ð¾Ð»Ð¾Ð¶ÐµÐ½Ð¸Ñ");
  else if (section.includes("223-Ð¤Ð")) tags.push("223-Ð¤Ð", "ÑÑÐ°Ð½Ð´Ð°ÑÑ");
  else if (section.includes("Ð²Ð½Ðµ 223-Ð¤Ð")) tags.push("Ð²Ð½Ðµ 223-Ð¤Ð", "ÑÑÐ°Ð½Ð´Ð°ÑÑ");
  else if (section.includes("Ð¿Ð»Ð°Ð½Ð¸ÑÐ¾Ð²Ð°Ð½Ð¸Ñ")) tags.push("Ð¿Ð»Ð°Ð½Ð¸ÑÐ¾Ð²Ð°Ð½Ð¸Ðµ");
  else if (section.includes("Ð¡ÐÐ ") || section.includes("ÐÐÐ ")) tags.push("Ð¡ÐÐ ", "ÐÐÐ ");
  else if (section.includes("Ð¦ÐµÐ½Ð¾Ð¾Ð±ÑÐ°Ð·Ð¾Ð²Ð°Ð½Ð¸Ðµ")) tags.push("ÑÐµÐ½Ð¾Ð¾Ð±ÑÐ°Ð·Ð¾Ð²Ð°Ð½Ð¸Ðµ");
  else if (section.includes("ÐÐ¾Ð³Ð¾Ð²Ð¾ÑÑ")) tags.push("Ð´Ð¾Ð³Ð¾Ð²Ð¾ÑÑ");
  else if (section.includes("ÐÐ½ÑÑÑÑÐºÑÐ¸Ð¸")) tags.push("Ð¸Ð½ÑÑÑÑÐºÑÐ¸Ð¸");
  else if (section.includes("ÐÐµÑÐ¾Ð´Ð¸ÑÐµÑÐºÐ¸Ðµ")) tags.push("Ð¼ÐµÑÐ¾Ð´Ð¸ÐºÐ°");
  else if (section.includes("Ð¡Ð¿ÑÐ°Ð²Ð¾ÑÐ½Ð¸ÐºÐ¸")) tags.push("ÑÐ¿ÑÐ°Ð²Ð¾ÑÐ½Ð¸ÐºÐ¸");
  if (tableType === "decision_matrix") tags.push("Ð¼Ð°ÑÑÐ¸ÑÐ° Ð¿Ð¾Ð»Ð½Ð¾Ð¼Ð¾ÑÐ¸Ð¹");
  else if (tableType === "registry") tags.push("ÑÐµÐµÑÑÑ");
  else if (tableType === "numeric") tags.push("ÑÐ¸ÑÐ»Ð¾Ð²ÑÐµ Ð´Ð°Ð½Ð½ÑÐµ");
  else if (tableType === "form") tags.push("ÑÐ¾ÑÐ¼Ð°");
  else if (tableType === "reference") tags.push("ÑÐ¿ÑÐ°Ð²Ð¾ÑÐ½Ð¸Ðº");
  tags.push("Ð´ÐµÐ½Ð¾ÑÐ¼Ð°Ð»Ð¸Ð·Ð¾Ð²Ð°Ð½Ð¾");
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
          content_preview: `ÐÐµÐ½Ð¾ÑÐ¼Ð°Ð»Ð¸Ð·Ð¾Ð²Ð°Ð½Ð¾: ${firstStmt.source_document}`,
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
    const embeddings = await embedDocuments(texts);

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
 * DELETE /api/ingest-jsonl â ÑÐ´Ð°Ð»ÑÐµÑ Ð²ÑÐµ Ð´ÐµÐ½Ð¾ÑÐ¼Ð°Ð»Ð¸Ð·Ð¾Ð²Ð°Ð½Ð½ÑÐµ Ð´Ð°Ð½Ð½ÑÐµ.
 */
export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();

  const { error: delChunks, count: chunksDeleted } = await supabase
    .from("chunks")
    .delete({ count: "exact" })
    .contains("tags", ["Ð´ÐµÐ½Ð¾ÑÐ¼Ð°Ð»Ð¸Ð·Ð¾Ð²Ð°Ð½Ð¾"]);

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
