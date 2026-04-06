import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { parseMarkdownTables } from "@/app/lib/markdown-tables";

/* ── Filename generator (matches DOCX export logic) ── */

const STOP_WORDS = new Set([
  "в", "на", "по", "с", "и", "а", "но", "или", "что", "как", "для", "из",
  "от", "до", "за", "при", "не", "ли", "бы", "же", "это", "то", "все",
  "он", "она", "они", "мы", "вы", "его", "её", "их", "мне", "нам", "вам",
  "о", "об", "у", "к", "ко", "та", "те", "тот", "эта", "эти", "этот",
  "какой", "какая", "какие", "чем", "кто", "где", "когда", "почему",
  "есть", "быть", "был", "была", "были", "будет", "может", "можно",
  "нужно", "надо", "ещё", "еще", "уже", "так", "очень", "более",
  "скажи", "расскажи", "объясни", "опиши", "подскажи", "покажи",
  "пожалуйста", "какое", "составь", "создай", "сделай", "таблицу",
  "таблица", "excel", "xlsx",
]);

function generateFilename(question: string): string {
  const words = question
    .replace(/[^\wа-яА-ЯёЁ\s-]/g, "")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const selected = words.slice(0, 4);

  if (selected.length === 0) {
    return `СнабЧат-${new Date().toISOString().slice(0, 10)}.xlsx`;
  }

  selected[0] = selected[0].charAt(0).toUpperCase() + selected[0].slice(1);
  return `${selected.join(" ")}.xlsx`;
}

/* ── Try to parse a cell value as a number ── */

function parseNumericValue(val: string): number | null {
  if (!val || val.startsWith("=")) return null;
  // Remove spaces used as thousand separators (common in Russian formatting)
  const cleaned = val.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "" || cleaned === "-") return null;
  const num = Number(cleaned);
  return isFinite(num) ? num : null;
}

/* ── API handler ── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { question, answer } = body;

    if (!answer) {
      return NextResponse.json(
        { error: "answer is required" },
        { status: 400 }
      );
    }

    const tables = parseMarkdownTables(answer);

    if (tables.length === 0) {
      return NextResponse.json(
        { error: "No tables found in answer" },
        { status: 400 }
      );
    }

    const workbook = new ExcelJS.Workbook();

    for (const table of tables) {
      // Truncate sheet name to Excel's 31-char limit
      const sheetName = table.name.slice(0, 31);
      const worksheet = workbook.addWorksheet(sheetName);

      for (const row of table.rows) {
        const typedRow = row.map((cell) => {
          if (typeof cell === "string" && cell.startsWith("=")) {
            return { formula: cell.slice(1) };
          }
          const num = parseNumericValue(cell);
          return num !== null ? num : cell;
        });
        worksheet.addRow(typedRow);
      }

      // Auto-size columns based on content
      for (let c = 1; c <= worksheet.columnCount; c++) {
        let maxLen = 8;
        const col = worksheet.getColumn(c);
        col.eachCell({ includeEmpty: false }, (cell) => {
          const len = (cell.text ?? String(cell.value ?? "")).length + 2;
          if (len > maxLen) maxLen = len;
        });
        col.width = Math.min(maxLen, 50);
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();

    const filename = generateFilename(question || "Таблица");
    const encodedFilename = encodeURIComponent(filename);

    return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="snabchat.xlsx"; filename*=UTF-8''${encodedFilename}`,
      },
    });
  } catch (error) {
    console.error("Excel export error:", error);
    return NextResponse.json(
      { error: "Failed to generate Excel file" },
      { status: 500 }
    );
  }
}
