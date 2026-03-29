// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  convertToMarkdown: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
  convertToHtml: (
    opts: { buffer: Buffer },
    options?: Record<string, unknown>
  ) => Promise<{ value: string }>;
  images: {
    imgElement: (
      fn: (image: {
        read: (encoding: string) => Promise<string>;
        contentType: string;
      }) => Promise<{ src: string }>
    ) => unknown;
  };
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

/* ── Exported image type ── */
export interface ExtractedImage {
  data: Buffer;
  mimeType: string;
  /** Placeholder marker in markdown, e.g. "[СКРИНШОТ 1]" */
  marker: string;
}

export interface ParseResult {
  markdown: string;
  images: ExtractedImage[];
}

/* ── Main entry point (updated signature) ── */
export async function parseToMarkdown(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<ParseResult> {
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filename.endsWith(".docx")
  ) {
    validateMagicBytes(buffer, [ZIP_MAGIC], "DOCX");
    return parseDocxWithImages(buffer);
  }

  if (mimeType === "application/pdf" || filename.endsWith(".pdf")) {
    validateMagicBytes(buffer, [PDF_MAGIC], "PDF");
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    let text = data.text;

    const isScannedPdf = !text || text.replace(/\s/g, "").length < 50;
    if (isScannedPdf) {
      console.log(
        `[parser] PDF "${filename}" appears to be scanned (extracted only ${text?.length || 0} chars). Using Gemini OCR...`
      );
      text = await ocrPdfWithGemini(buffer, filename);
    }

    return { markdown: addHeadingHeuristics(text), images: [] };
  }

  if (
    EXCEL_MIMES.includes(mimeType) ||
    filename.endsWith(".xlsx") ||
    filename.endsWith(".xls")
  ) {
    return { markdown: parseExcelToMarkdown(buffer, filename), images: [] };
  }

  // Image OCR via Gemini Vision
  if (
    IMAGE_MIMES.includes(mimeType) ||
    /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filename)
  ) {
    const md = await parseImageToMarkdown(buffer, mimeType);
    return { markdown: md, images: [] };
  }

  // Fallback: plain text
  return { markdown: buffer.toString("utf-8"), images: [] };
}

/* ── DOCX parser with image extraction ── */

async function parseDocxWithImages(buffer: Buffer): Promise<ParseResult> {
  const images: ExtractedImage[] = [];
  let imageIndex = 0;

  // Step 1: Extract HTML with image placeholders
  const result = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const base64 = await image.read("base64");
      const imgData = Buffer.from(base64, "base64");
      const mime = image.contentType || "image/png";

      // Skip tiny images (icons, bullets, decorative elements < 2KB)
      if (imgData.length < 2048) {
        return { src: "" };
      }

      imageIndex++;
      const marker = `[СКРИНШОТ ${imageIndex}]`;

      images.push({
        data: imgData,
        mimeType: mime,
        marker,
      });

      // Insert a unique placeholder that survives HTML-to-markdown conversion
      return { src: `__IMG_PLACEHOLDER_${imageIndex}__` };
    }),
  });

  // Step 2: Convert HTML to markdown-like text
  let markdown = htmlToSimpleMarkdown(result.value);

  // Step 3: Replace image placeholders with readable markers
  for (let i = 1; i <= images.length; i++) {
    // mammoth wraps img in <img src="...">, after HTML conversion it becomes
    // something like ![](__IMG_PLACEHOLDER_N__) or just the raw placeholder
    const placeholder = `__IMG_PLACEHOLDER_${i}__`;
    const marker = `[СКРИНШОТ ${i}]`;

    // Replace all forms the placeholder might appear in
    markdown = markdown.replace(
      new RegExp(`!\\[\\]\\(${placeholder}\\)`, "g"),
      `\n\n${marker}\n\n`
    );
    markdown = markdown.replace(
      new RegExp(placeholder, "g"),
      `\n\n${marker}\n\n`
    );
  }

  // Remove empty image refs (from skipped small images)
  markdown = markdown.replace(/!\[\]\(\s*\)/g, "");

  // Clean up excessive newlines
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  console.log(
    `[parser] DOCX parsed: ${markdown.length} chars, ${images.length} images extracted`
  );

  return { markdown, images };
}

/* ── Simple HTML to Markdown converter ── */

function htmlToSimpleMarkdown(html: string): string {
  let md = html;

  // Headers
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n");
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n");
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n");
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "\n#### $1\n");

  // Bold and italic
  md = md.replace(/<strong>(.*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b>(.*?)<\/b>/gi, "**$1**");
  md = md.replace(/<em>(.*?)<\/em>/gi, "*$1*");
  md = md.replace(/<i>(.*?)<\/i>/gi, "*$1*");

  // Images (keep src for placeholder replacement)
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

  // List items
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  md = md.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  // Tables: convert HTML tables to markdown tables
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
    const rows: string[][] = [];
    const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const row of rowMatches) {
      const cells: string[] = [];
      const cellMatches = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      for (const cell of cellMatches) {
        const text = cell
          .replace(/<t[hd][^>]*>/i, "")
          .replace(/<\/t[hd]>/i, "")
          .replace(/<[^>]+>/g, "")
          .trim();
        cells.push(text);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return "";

    const maxCols = Math.max(...rows.map((r) => r.length));
    const lines: string[] = [];
    rows.forEach((row, idx) => {
      const padded = Array.from({ length: maxCols }, (_, i) => row[i] || "");
      lines.push("| " + padded.join(" | ") + " |");
      if (idx === 0) {
        lines.push("| " + padded.map(() => "---").join(" | ") + " |");
      }
    });
    return "\n" + lines.join("\n") + "\n";
  });

  // Paragraphs and line breaks
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<p[^>]*>/gi, "\n");
  md = md.replace(/<\/p>/gi, "\n");

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  md = md.replace(/&amp;/g, "&");
  md = md.replace(/&lt;/g, "<");
  md = md.replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, "\n\n");
  md = md.trim();

  return md;
}

/* ── Existing helpers (unchanged) ── */

async function ocrPdfWithGemini(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

  const base64 = buffer.toString("base64");

  const result = await withGoogleApiLimit(async () => {
    return client.models.generateContent({
      model: "gemini-3-flash-preview",
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

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]);

function validateMagicBytes(
  buffer: Buffer,
  expected: Buffer[],
  label: string
): void {
  const head = buffer.subarray(0, 4);
  if (!expected.some((magic) => head.equals(magic))) {
    throw new Error(`Файл не является валидным ${label}-документом`);
  }
}

function parseExcelToMarkdown(buffer: Buffer, filename: string): string {
  validateMagicBytes(buffer, [ZIP_MAGIC, OLE2_MAGIC], "Excel");

  const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
  const parts: string[] = [];

  const cleanName = filename.replace(/\.(xlsx|xls)$/i, "").replace(/_/g, " ");
  parts.push(`# ${cleanName}\n`);

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    if (totalRows === 0 || totalCols === 0) continue;

    if (workbook.SheetNames.length > 1) {
      parts.push(`## Лист: ${sheetName}\n`);
    }

    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (rows.length === 0) continue;

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

    const firstRow = rows[0];
    const isHeaderRow = firstRow.every(
      (c) =>
        typeof c === "string" ||
        (String(c).length < 80 && isNaN(Number(c)))
    );

    if (rows.length <= 30) {
      const header = rows[0].map((c) =>
        String(c).replace(/\|/g, "\\|").replace(/\n/g, " ").trim()
      );
      if (header.length === 0 || header.every((h) => h === "")) continue;

      parts.push("| " + header.join(" | ") + " |");
      parts.push("| " + header.map(() => "---").join(" | ") + " |");

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every((c) => String(c).trim() === "")) continue;
        parts.push(
          "| " +
            header
              .map((_, j) =>
                String(row[j] ?? "")
                  .replace(/\|/g, "\\|")
                  .replace(/\n/g, " ")
                  .trim()
              )
              .join(" | ") +
            " |"
        );
      }
      parts.push("");
    } else {
      const headerRow = isHeaderRow ? rows[0] : null;

      if (headerRow) {
        parts.push(
          `**Столбцы**: ${headerRow.filter(Boolean).map(String).join(", ")}\n`
        );
      }

      const dataRows = isHeaderRow ? rows.slice(1) : rows;

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        if (row.every((c) => String(c).trim() === "")) continue;

        if (headerRow) {
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
          const vals = row.map((c) => String(c).trim()).filter(Boolean);
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

    if (
      trimmed.length <= 120 &&
      trimmed === trimmed.toUpperCase() &&
      /[А-ЯA-Z]/.test(trimmed) &&
      !/^\d+[\.\)]/.test(trimmed)
    ) {
      result.push(`## ${trimmed}`);
      continue;
    }

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
