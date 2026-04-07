import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import ExcelJS from "exceljs";
import { parseMarkdownTables } from "@/app/lib/markdown-tables";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

export interface ExcelSheet {
  name: string;
  rows: string[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  colWidths: number[];
}

export async function GET(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return unauthorizedResponse();

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
      const workbook = new ExcelJS.Workbook();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await workbook.xlsx.load(buffer as any);
      } catch {
        // If ExcelJS can't load the file, fall through to markdown fallback
      }
      const sheets: ExcelSheet[] = [];

      for (const ws of workbook.worksheets) {
        const totalCols = ws.columnCount;
        if (ws.rowCount === 0 || totalCols === 0) continue;

        const rows: string[][] = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const vals: string[] = [];
          for (let c = 1; c <= totalCols; c++) {
            const cell = row.getCell(c);
            let cellText = "";
            try {
              cellText = cell.text ?? String(cell.value ?? "");
            } catch {
              try { cellText = String(cell.value ?? ""); } catch { cellText = ""; }
            }
            vals.push(cellText);
          }
          rows.push(vals);
        });

        if (rows.length === 0) continue;

        // Get merged cells (convert to 0-based format matching old API)
        const merges: ExcelSheet["merges"] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wsAny = ws as any;
        if (wsAny._merges) {
          for (const key of Object.keys(wsAny._merges)) {
            const m = wsAny._merges[key].model;
            merges.push({
              s: { r: m.top - 1, c: m.left - 1 },
              e: { r: m.bottom - 1, c: m.right - 1 },
            });
          }
        }

        // Get column widths
        const colWidths: number[] = [];
        for (let i = 1; i <= totalCols; i++) {
          const col = ws.getColumn(i);
          colWidths.push(col.width ? Math.round(col.width) : 0);
        }

        // Normalize row lengths
        const maxCols = Math.max(...rows.map((r) => r.length), 0);
        sheets.push({
          name: ws.name,
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
  const excelSheets: ExcelSheet[] = parsed.map((s) => ({
    ...s,
    merges: [],
    colWidths: [],
  }));

  return NextResponse.json({ sheets: excelSheets, filename: source.filename });
}
