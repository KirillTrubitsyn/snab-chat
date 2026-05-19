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
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { google, withGoogleApiLimit } from "./google-ai";
import { generateText } from "ai";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

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

const AUDIO_MIMES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
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

  if (
    mimeType === "application/msword" ||
    filename.endsWith(".doc")
  ) {
    // Mammoth не поддерживает бинарный .doc (Word 97-2003) полноценно.
    // Пробуем mammoth, при ошибке — Gemini OCR.
    try {
      return await parseDocxWithImages(buffer);
    } catch {
      console.log(`[parser] mammoth failed for "${filename}", falling back to Gemini OCR`);
      const markdown = await ocrDocWithGemini(buffer, filename);
      return { markdown, images: [] };
    }
  }

  if (mimeType === "application/pdf" || filename.endsWith(".pdf")) {
    validateMagicBytes(buffer, [PDF_MAGIC], "PDF");
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    let text = data.text;

    const isScannedPdf = !text || text.replace(/\s/g, "").length < 200;
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
    return { markdown: await parseExcelToMarkdown(buffer, filename), images: [] };
  }

  if (
    mimeType === PPTX_MIME ||
    filename.endsWith(".pptx")
  ) {
    validateMagicBytes(buffer, [ZIP_MAGIC], "PPTX");
    return parsePptxWithImages(buffer);
  }

  // Audio transcription via Gemini
  if (
    AUDIO_MIMES.includes(mimeType) ||
    /\.(mp3|wav)$/i.test(filename)
  ) {
    const md = await transcribeAudioWithGemini(buffer, mimeType, filename);
    return { markdown: md, images: [] };
  }

  // Image OCR via Gemini Vision
  if (
    IMAGE_MIMES.includes(mimeType) ||
    /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filename)
  ) {
    const md = await parseImageToMarkdown(buffer, mimeType);
    return { markdown: md, images: [] };
  }

  // HTML files
  if (
    mimeType === "text/html" ||
    mimeType === "application/xhtml+xml" ||
    filename.endsWith(".html") ||
    filename.endsWith(".htm")
  ) {
    const html = buffer.toString("utf-8");
    const markdown = htmlToSimpleMarkdown(html);
    return { markdown, images: [] };
  }

  // Fallback: plain text
  return { markdown: buffer.toString("utf-8"), images: [] };
}

/* ── PPTX parser with image extraction ── */

async function parsePptxWithImages(buffer: Buffer): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(buffer);
  const images: ExtractedImage[] = [];

  // 1. Collect all slide filenames and sort numerically
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/i)?.[1] || "0", 10);
      const nb = parseInt(b.match(/slide(\d+)/i)?.[1] || "0", 10);
      return na - nb;
    });

  // 2. Build media map: rId → { data, mimeType } for each slide
  const mediaCache = new Map<string, { data: Buffer; mime: string }>();
  for (const key of Object.keys(zip.files)) {
    if (/^ppt\/media\//i.test(key) && !zip.files[key].dir) {
      const ext = key.split(".").pop()?.toLowerCase() || "png";
      const mime =
        ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "gif"
            ? "image/gif"
            : ext === "emf"
              ? "image/x-emf"
              : ext === "wmf"
                ? "image/x-wmf"
                : `image/${ext}`;
      const data = Buffer.from(await zip.files[key].async("arraybuffer"));
      mediaCache.set(key, { data, mime });
    }
  }

  const mdParts: string[] = [];
  let globalImageIdx = 0;

  for (const slideFile of slideFiles) {
    const slideNum = parseInt(
      slideFile.match(/slide(\d+)/i)?.[1] || "0",
      10
    );
    const slideXml = await zip.files[slideFile].async("text");

    // 3. Extract text from <a:t> tags, preserving paragraph breaks
    const paragraphs: string[] = [];
    // Split by <a:p> paragraph elements
    const pParts = slideXml.split(/<a:p[\s>]/);
    for (const pp of pParts) {
      // Extract all <a:t>...</a:t> text runs within the paragraph
      const textRuns: string[] = [];
      const tRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
      let m;
      while ((m = tRegex.exec(pp)) !== null) {
        const t = m[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
        if (t) textRuns.push(t);
      }
      if (textRuns.length > 0) {
        paragraphs.push(textRuns.join(" "));
      }
    }

    // 4. Parse slide relationships to find images on this slide
    const relsPath = slideFile.replace(
      /ppt\/slides\/(slide\d+\.xml)/i,
      "ppt/slides/_rels/$1.rels"
    );
    const slideImagePaths: string[] = [];

    if (zip.files[relsPath]) {
      const relsXml = await zip.files[relsPath].async("text");
      const relRegex =
        /<Relationship[^>]+Target="([^"]*)"[^>]+Type="[^"]*\/image"[^>]*\/?>/gi;
      // Also match reversed attribute order
      const relRegex2 =
        /<Relationship[^>]+Type="[^"]*\/image"[^>]+Target="([^"]*)"[^>]*\/?>/gi;

      const targets = new Set<string>();
      let rm;
      while ((rm = relRegex.exec(relsXml)) !== null) targets.add(rm[1]);
      while ((rm = relRegex2.exec(relsXml)) !== null) targets.add(rm[1]);

      for (const target of targets) {
        // Target is relative like "../media/image1.png"
        const mediaPath = target.startsWith("../")
          ? `ppt/${target.slice(3)}`
          : target.startsWith("/")
            ? target.slice(1)
            : `ppt/slides/${target}`;
        if (mediaCache.has(mediaPath)) {
          slideImagePaths.push(mediaPath);
        }
      }
    }

    // Skip slides with no text and no images
    if (paragraphs.length === 0 && slideImagePaths.length === 0) continue;

    mdParts.push(`\n## Слайд ${slideNum}\n`);

    if (paragraphs.length > 0) {
      mdParts.push(paragraphs.join("\n\n"));
    }

    // 5. Add images from this slide
    for (const imgPath of slideImagePaths) {
      const media = mediaCache.get(imgPath)!;
      // Skip tiny images (icons, bullets < 2KB) and EMF/WMF (vector graphics, not screenshots)
      if (
        media.data.length < 2048 ||
        media.mime === "image/x-emf" ||
        media.mime === "image/x-wmf"
      ) {
        continue;
      }

      globalImageIdx++;
      const marker = `[СКРИНШОТ ${globalImageIdx}]`;
      images.push({
        data: media.data,
        mimeType: media.mime,
        marker,
      });
      mdParts.push(`\n${marker}\n`);
    }
  }

  const markdown = mdParts.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  console.log(
    `[parser] PPTX parsed: ${slideFiles.length} slides, ${markdown.length} chars, ${images.length} images extracted`
  );

  return { markdown, images };
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
  // Strip <style>, <script>, and HTML comments before conversion
  let md = html;
  md = md.replace(/<style[\s\S]*?<\/style>/gi, "");
  md = md.replace(/<script[\s\S]*?<\/script>/gi, "");
  md = md.replace(/<!--[\s\S]*?-->/g, "");
  // Convert semantic HTML5 elements to paragraph breaks
  md = md.replace(/<\/?(section|article|nav|aside|header|footer|main|figure|figcaption)[^>]*>/gi, "\n\n");

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
        let cellHtml = cell
          .replace(/<t[hd][^>]*>/i, "")
          .replace(/<\/t[hd]>/i, "");
        // Convert inline formatting before stripping tags
        cellHtml = cellHtml.replace(/<strong>(.*?)<\/strong>/gi, "**$1**");
        cellHtml = cellHtml.replace(/<b>(.*?)<\/b>/gi, "**$1**");
        cellHtml = cellHtml.replace(/<em>(.*?)<\/em>/gi, "*$1*");
        cellHtml = cellHtml.replace(/<li[^>]*>(.*?)<\/li>/gi, "$1; ");
        cellHtml = cellHtml.replace(/<br\s*\/?>/gi, " ");
        cellHtml = cellHtml.replace(/<[^>]+>/g, "");
        cells.push(cellHtml.trim());
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
      model: "gemini-3.5-flash",
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

async function transcribeAudioWithGemini(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

  const base64 = buffer.toString("base64");
  const audioMime = /\.wav$/i.test(filename) ? "audio/wav" : "audio/mpeg";

  const result = await withGoogleApiLimit(async () => {
    return client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: audioMime,
                data: base64,
              },
            },
            {
              text: `Транскрибируй эту аудиозапись. Файл называется "${filename}".
Правила:
- Запиши весь произнесённый текст дословно
- Если есть несколько говорящих — отмечай смену спикера
- Сохраняй структуру: абзацы для пауз, списки если перечисляют
- Не добавляй ничего от себя, только то, что сказано в записи
- Результат верни в формате markdown`,
            },
          ],
        },
      ],
    });
  });

  const extractedText = result.text ?? "";
  console.log(
    `[parser] Gemini transcribed ${extractedText.length} chars from audio "${filename}"`
  );
  return extractedText;
}

async function ocrDocWithGemini(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

  const base64 = buffer.toString("base64");

  const result = await withGoogleApiLimit(async () => {
    return client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "application/msword",
                data: base64,
              },
            },
            {
              text: `Извлеки весь текст из этого документа Word (.doc). Документ называется "${filename}".
Правила:
- Сохраняй структуру документа: заголовки, абзацы, списки, таблицы
- Таблицы форматируй в markdown-формате
- Если документ содержит приказ, положение или другой нормативный документ — сохрани нумерацию пунктов
- Не добавляй ничего от себя, извлекай только то, что есть в документе
- Результат верни в формате markdown`,
            },
          ],
        },
      ],
    });
  });

  const extractedText = result.text ?? "";
  console.log(
    `[parser] Gemini OCR extracted ${extractedText.length} chars from DOC "${filename}"`
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
      model: google("gemini-3.5-flash"),
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
      maxOutputTokens: 8000,
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


/**
 * Extract text representation of an ExcelJS cell.
 *
 * Priority:
 *   1. Computed numeric / formatted result (cell.text), if non-empty.
 *   2. Formula-cell `result` field — present when Excel itself last saved
 *      the workbook. Without this fallback, files where formulas weren't
 *      computed leak raw "=AVERAGE(B2:B4)" strings into the markdown chunk.
 *   3. Raw value as last resort. For formula objects we mark the cell
 *      explicitly so downstream LLM knows the formula was not pre-computed.
 *
 * Замечание №2 от 04.05.2026: модель выводила формулы вместо посчитанных
 * итогов, потому что в чанк попадал сырой текст формулы.
 */
function extractCellText(cell: ExcelJS.Cell): string {
  // 1. Formatted result wins when present
  const text = cell.text;
  if (text != null && text !== "") {
    // ExcelJS sometimes returns the formula string itself in `text` for
    // un-computed formula cells. Detect and fall through.
    if (typeof text === "string" && text.startsWith("=") && text.length > 1) {
      // intentional fallthrough
    } else {
      return String(text);
    }
  }

  const value = cell.value;
  if (value == null) return "";

  // 2. Formula object — prefer .result, else mark explicitly
  if (typeof value === "object" && value !== null && "formula" in value) {
    const formulaObj = value as { formula?: string; result?: unknown; sharedFormula?: string };
    if (formulaObj.result != null && formulaObj.result !== "") {
      return String(formulaObj.result);
    }
    const f = formulaObj.formula ?? formulaObj.sharedFormula ?? "";
    return f ? `[формула не вычислена: =${f}]` : "";
  }

  // 3. Plain primitive
  return String(value);
}

async function parseExcelToMarkdown(buffer: Buffer, filename: string): Promise<string> {
  const head = buffer.subarray(0, 4);

  // OLE2 magic bytes — это старый бинарный формат Excel 97-2003 (.xls).
  // ExcelJS поддерживает только .xlsx (ZIP/OOXML).
  if (head.equals(OLE2_MAGIC)) {
    throw new Error(
      "Файл в старом формате Excel 97-2003 (.xls). " +
      "Откройте его в Microsoft Excel и сохраните как «Книга Excel (.xlsx)», затем загрузите снова."
    );
  }

  if (!head.equals(ZIP_MAGIC)) {
    throw new Error("Файл не является валидным Excel-документом (.xlsx)");
  }

  const workbook = new ExcelJS.Workbook();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Не удалось прочитать файл Excel: ${msg}`);
  }

  const parts: string[] = [];

  const cleanName = filename.replace(/\.(xlsx|xls)$/i, "").replace(/_/g, " ");
  parts.push(`# ${cleanName}\n`);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);

  for (const ws of workbook.worksheets) {
    const totalRows = ws.rowCount;
    const totalCols = ws.columnCount;
    if (totalRows === 0 || totalCols === 0) continue;

    if (sheetNames.length > 1) {
      parts.push(`## Лист: ${ws.name}\n`);
    }

    // Read all rows as string arrays
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = [];
      for (let c = 1; c <= totalCols; c++) {
        const cell = row.getCell(c);
        let cellText = "";
        try {
          cellText = extractCellText(cell);
        } catch {
          try { cellText = String(cell.value ?? ""); } catch { cellText = ""; }
        }
        vals.push(cellText);
      }
      rows.push(vals);
    });

    if (rows.length === 0) continue;

    // Build merge map from worksheet merges
    const mergeMap = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsAny = ws as any;
    if (wsAny._merges) {
      for (const key of Object.keys(wsAny._merges)) {
        const m = wsAny._merges[key].model;
        const topCell = ws.getRow(m.top).getCell(m.left);
        let val = "";
        try {
          val = extractCellText(topCell);
        } catch {
          try { val = String(topCell.value ?? ""); } catch { val = ""; }
        }
        for (let r = m.top; r <= m.bottom; r++) {
          for (let c = m.left; c <= m.right; c++) {
            mergeMap.set(`${r - 1}:${c - 1}`, val);
          }
        }
      }
    }

    const firstRow = rows[0];
    const isHeaderRow = firstRow.every(
      (c) =>
        typeof c === "string" ||
        (String(c).length < 80 && isNaN(Number(c)))
    );

    // Get the starting row index (ExcelJS rows are 1-based, but our array is 0-based)
    // We use 0-based indexing for the mergeMap keys

    if (rows.length <= 30) {
      const header = rows[0].map((c, j) => {
        const val = String(c).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
        return val || mergeMap.get(`0:${j}`) || "";
      });
      if (header.length === 0 || header.every((h) => h === "")) continue;

      parts.push("| " + header.join(" | ") + " |");
      parts.push("| " + header.map(() => "---").join(" | ") + " |");

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every((c) => String(c).trim() === "")) continue;
        parts.push(
          "| " +
            header
              .map((_, j) => {
                const raw = String(row[j] ?? "").trim();
                const merged = raw || mergeMap.get(`${i}:${j}`) || "";
                return merged.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
              })
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
      const dataStartRow = isHeaderRow ? 1 : 0;

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        if (row.every((c) => String(c).trim() === "")) continue;

        if (headerRow) {
          const pairs = headerRow
            .map((h, j) => {
              const raw = String(row[j] ?? "").trim();
              const val = raw || mergeMap.get(`${dataStartRow + i}:${j}`) || "";
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
