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
    let text = data.text;

    // Check if PDF is scanned (image-based) — too little text extracted
    const isScannedPdf = !text || text.replace(/\s/g, "").length < 50;
    if (isScannedPdf) {
      console.log(
        `[parser] PDF "${filename}" appears to be scanned (extracted only ${text?.length || 0} chars). Using Gemini OCR...`
      );
      text = await ocrPdfWithGemini(buffer, filename);
    }

    return addHeadingHeuristics(text);
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

async function ocrPdfWithGemini(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

  const base64 = buffer.toString("base64");

  const result = await withGoogleApiLimit(async () => {
    return client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: base64,
              },
            },
            {
              text: `Извлеки весь текст из этого PDF-документа. Документ называется "${filename}".
Правила:
- Сохраняй структуру документа: заголовки, абзацы, списки, таблицы
- Таблицы форматируй в markdown-формате
- Если документ содержит приказ, положение или другой нормативный документ — сохрани нумерацию пунктов
- Не добавляй ничего от себя, извлекай только то, что есть в документе
- Если текст нечитаем или размыт — пропусти этот фрагмент
- Результат верни в формате markdown`,
            },
          ],
        },
      ],
    });
  });

  const extractedText = result.text ?? "";
  console.log(
    `[parser] Gemini OCR extracted ${extractedText.length} chars from "${filename}"`
  );
  return extractedText;
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
  const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
  const parts: string[] = [];

  // Add filename as document header
  const cleanName = filename
    .replace(/\.(xlsx|xls)$/i, "")
    .replace(/_/g, " ");
  parts.push(`# ${cleanName}\n`);

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    if (totalRows === 0 || totalCols === 0) continue;

    // Sheet heading
    if (workbook.SheetNames.length > 1) {
      parts.push(`## Лист: ${sheetName}\n`);
    }

    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (rows.length === 0) continue;

    // Handle merged cells: detect and annotate
    const merges = sheet["!merges"] || [];
    const mergeMap = new Map<string, string>();
    for (const merge of merges) {
      const topLeft = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
      const val = sheet[topLeft]?.v ?? "";
      for (let r = merge.s.r; r <= merge.e.r; r++) {
        for (let c = merge.s.c; c <= merge.e.c; c++) {
          const key = `${r}:${c}`;
          mergeMap.set(key, String(val));
        }
      }
    }

    // Detect if first row is likely a header (non-numeric, short values)
    const firstRow = rows[0];
    const isHeaderRow = firstRow.every(
      (c) => typeof c === "string" || (String(c).length < 80 && isNaN(Number(c)))
    );

    // For small tables (< 30 rows): use markdown table format
    if (rows.length <= 30) {
      const header = rows[0].map((c) =>
        String(c).replace(/\|/g, "\\|").replace(/\n/g, " ").trim()
      );
      if (header.length === 0 || header.every((h) => h === "")) continue;

      parts.push(
        "| " + header.join(" | ") + " |"
      );
      parts.push("| " + header.map(() => "---").join(" | ") + " |");

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every((c) => String(c).trim() === "")) continue;
        parts.push(
          "| " +
            header.map((_, j) =>
              String(row[j] ?? "")
                .replace(/\|/g, "\\|")
                .replace(/\n/g, " ")
                .trim()
            ).join(" | ") +
            " |"
        );
      }
      parts.push("");
    } else {
      // For large tables (> 30 rows): use structured text format
      // This is better for RAG because markdown tables get mangled in chunking
      const headerRow = isHeaderRow ? rows[0] : null;

      if (headerRow) {
        parts.push(`**Столбцы**: ${headerRow.filter(Boolean).map(String).join(", ")}\n`);
      }

      const dataRows = isHeaderRow ? rows.slice(1) : rows;

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        if (row.every((c) => String(c).trim() === "")) continue;

        if (headerRow) {
          // Named format: "Столбец: Значение"
          const pairs = headerRow
            .map((h, j) => {
              const val = String(row[j] ?? "").trim();
              const hStr = String(h).trim();
              return val && hStr ? `${hStr}: ${val}` : null;
            })
            .filter(Boolean);
          if (pairs.length > 0) {
            parts.push(`- Строка ${i + 1}: ${pairs.join(" | ")}`);
          }
        } else {
          // No header: just list values
          const vals = row
            .map((c) => String(c).trim())
            .filter(Boolean);
          if (vals.length > 0) {
            parts.push(`- ${vals.join(" | ")}`);
          }
        }
      }
      parts.push("");
    }
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
