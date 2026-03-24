import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import * as XLSX from "xlsx";
import { parseMarkdownTables } from "@/app/lib/markdown-tables";

export interface ExcelSheet {
  name: string;
  rows: string[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  colWidths: number[];
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select("id, filename, mime_type, storage_path")
    .eq("id", id)
    .single();

  if (sourceError || !source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  // Try to get original file from storage
  if (source.storage_path) {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(source.storage_path);

    if (!downloadError && fileData) {
      const buffer = Buffer.from(await fileData.arrayBuffer());
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets: ExcelSheet[] = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;

        const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: "",
          raw: false,
        });

        if (rows.length === 0) continue;

        // Get merged cells
        const merges = (sheet["!merges"] || []).map((m) => ({
          s: { r: m.s.r, c: m.s.c },
          e: { r: m.e.r, c: m.e.c },
        }));

        // Get column widths
        const cols = sheet["!cols"] || [];
        const maxCols = Math.max(...rows.map((r) => r.length), 0);
        const colWidths: number[] = [];
        for (let i = 0; i < maxCols; i++) {
          const w = cols[i]?.wch || cols[i]?.wpx
            ? Math.round((cols[i]?.wpx || 64) / 7)
            : 0;
          colWidths.push(w);
        }

        sheets.push({
          name: sheetName,
          rows: rows.map((row) =>
            Array.from({ length: maxCols }, (_, i) => String(row[i] ?? ""))
          ),
          merges,
          colWidths,
        });
      }

      return NextResponse.json({ sheets, filename: source.filename });
    }
  }

  // Fallback: parse markdown table from chunks
  const { data: chunks, error: chunksError } = await supabase
    .from("chunks")
    .select("content, chunk_index")
    .eq("source_id", source.id)
    .order("chunk_index", { ascending: true });

  if (chunksError || !chunks || chunks.length === 0) {
    return NextResponse.json({ error: "No content" }, { status: 404 });
  }

  const markdown = chunks.map((c) => c.content).join("\n\n");
  const parsed = parseMarkdownTables(markdown, source.filename);
  const sheets: ExcelSheet[] = parsed.map((s) => ({
    ...s,
    merges: [],
    colWidths: [],
  }));

  return NextResponse.json({ sheets, filename: source.filename });
}
