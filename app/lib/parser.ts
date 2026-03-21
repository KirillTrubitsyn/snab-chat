// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  convertToMarkdown: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
};
import * as XLSX from "xlsx";

const EXCEL_MIMES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];

export async function parseToMarkdown(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filename.endsWith(".docx")
  ) {
    const result = await mammoth.convertToMarkdown({ buffer });
    return result.value;
  }

  if (mimeType === "application/pdf" || filename.endsWith(".pdf")) {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return addHeadingHeuristics(data.text);
  }

  if (
    EXCEL_MIMES.includes(mimeType) ||
    filename.endsWith(".xlsx") ||
    filename.endsWith(".xls")
  ) {
    return parseExcelToMarkdown(buffer, filename);
  }

  // Fallback: treat as plain text
  return buffer.toString("utf-8");
}

function parseExcelToMarkdown(buffer: Buffer, filename: string): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    });

    if (rows.length === 0) continue;

    // Sheet heading
    if (workbook.SheetNames.length > 1) {
      parts.push(`## ${sheetName}`);
    } else {
      parts.push(`## ${filename}`);
    }

    // Build markdown table
    const header = rows[0];
    if (header.length === 0) continue;

    parts.push(
      "| " + header.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ") + " |"
    );
    parts.push("| " + header.map(() => "---").join(" | ") + " |");

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Skip completely empty rows
      if (row.every((c) => String(c).trim() === "")) continue;
      parts.push(
        "| " +
          header.map((_, j) =>
            String(row[j] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")
          ).join(" | ") +
          " |"
      );
    }

    parts.push("");
  }

  return parts.join("\n");
}

function addHeadingHeuristics(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push("");
      continue;
    }

    // Short uppercase lines → heading
    if (
      trimmed.length <= 120 &&
      trimmed === trimmed.toUpperCase() &&
      /[А-ЯA-Z]/.test(trimmed) &&
      !/^\d+[\.\)]/.test(trimmed)
    ) {
      result.push(`## ${trimmed}`);
      continue;
    }

    // Numbered sections like "1. TITLE" or "Глава 3"
    if (/^(Глава|Раздел|Статья|ГЛАВА|РАЗДЕЛ|СТАТЬЯ)\s+\d/i.test(trimmed)) {
      result.push(`## ${trimmed}`);
      continue;
    }

    if (/^\d+\.\s+[A-ZА-Я]/.test(trimmed) && trimmed.length <= 100) {
      result.push(`### ${trimmed}`);
      continue;
    }

    result.push(trimmed);
  }

  return result.join("\n");
}
