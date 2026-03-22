// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  convertToMarkdown: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
};
import * as XLSX from "xlsx";
import { google, withGoogleApiLimit } from "./google-ai";
import { generateText } from "ai";

const EXCEL_MIMES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];

const IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/webp",
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

  // Image OCR via Gemini Vision
  if (
    IMAGE_MIMES.includes(mimeType) ||
    /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filename)
  ) {
    return parseImageToMarkdown(buffer, mimeType);
  }

  // Fallback: treat as plain text
  return buffer.toString("utf-8");
}

async function parseImageToMarkdown(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const base64 = buffer.toString("base64");
  const mediaMime = IMAGE_MIMES.includes(mimeType) ? mimeType : "image/jpeg";

  const { text } = await withGoogleApiLimit(() =>
    generateText({
      model: google("gemini-3-flash-preview"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: `data:${mediaMime};base64,${base64}`,
            },
            {
              type: "text",
              text: `Ты — OCR-система. Извлеки ВЕСЬ текст из этого изображения документа.

Правила:
1. Сохраняй структуру документа (заголовки, абзацы, списки, таблицы)
2. Используй markdown-форматирование
3. Таблицы оформляй как markdown-таблицы
4. Если текст на русском — сохраняй на русском
5. Не добавляй свои комментарии, только извлечённый текст
6. Если изображение не содержит текста, напиши: "(изображение без текста)"`,
            },
          ],
        },
      ],
      maxTokens: 8000,
      temperature: 0,
    })
  );

  return text || "(не удалось распознать текст)";
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
