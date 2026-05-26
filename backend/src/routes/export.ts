import { Router, Request, Response } from "express";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  BorderStyle,
  Header,
  Footer,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  LevelFormat,
} from "docx";
import ExcelJS from "exceljs";
import { generateDocxFilename, generateXlsxFilename, asciiFilename } from "../lib/export-filenames.js";
import { parseMarkdownTables } from "../lib/markdown-tables.js";
import { requireAuth } from "../lib/auth.js";

const router = Router();

type BlockElement = Paragraph | Table;

/* ── Palette (monochrome, document-style) ── */

const TEXT_HEAD = "1F2937";    // h1/h2 — near-black
const TEXT_BODY = "111827";    // h3/h4, body emphasis
const TEXT_MUTED = "6B7280";   // labels, dates, bullets, meta
const BORDER_LIGHT = "D1D5DB"; // separators, quote bar
const FONT_DISPLAY = "Plus Jakarta Sans";
const FONT_BODY = "Source Sans 3";
const DATE_LOCALE = "ru-RU";
const BULLET_REF = "snabchat-bullets";

/* ── Markdown to DOCX paragraphs ── */

function parseMarkdownToParagraphs(text: string): BlockElement[] {
  const paragraphs: BlockElement[] = [];
  const lines = text.split("\n");
  let inTable = false;
  let tableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table detection
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      if (!inTable) {
        inTable = true;
        tableLines = [];
      }
      tableLines.push(line);
      continue;
    } else if (inTable) {
      inTable = false;
      const tableParagraphs = parseTable(tableLines);
      paragraphs.push(...tableParagraphs);
      tableLines = [];
    }

    // Empty line
    if (!line.trim()) {
      paragraphs.push(new Paragraph({ spacing: { after: 80 } }));
      continue;
    }

    // Headers (tolerate missing space after `#` just in case normalization missed it)
    const h1Match = line.match(/^#\s*(.+)/);
    if (h1Match && /^#\s/.test(line) && !/^##/.test(line)) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: stripResidualMarkdown(h1Match[1]),
              bold: true,
              size: 28,
              font: FONT_DISPLAY,
              color: TEXT_HEAD,
            }),
          ],
          spacing: { before: 240, after: 120 },
          alignment: AlignmentType.LEFT,
        })
      );
      continue;
    }

    const h2Match = line.match(/^##\s*(.+)/);
    if (h2Match && !/^###/.test(line)) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: stripResidualMarkdown(h2Match[1]),
              bold: true,
              size: 26,
              font: FONT_DISPLAY,
              color: TEXT_HEAD,
            }),
          ],
          spacing: { before: 200, after: 100 },
          alignment: AlignmentType.LEFT,
        })
      );
      continue;
    }

    const h3Match = line.match(/^###\s*(.+)/);
    if (h3Match && !/^####/.test(line)) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: stripResidualMarkdown(h3Match[1]),
              bold: true,
              size: 24,
              font: FONT_DISPLAY,
              color: TEXT_BODY,
            }),
          ],
          spacing: { before: 160, after: 80 },
          alignment: AlignmentType.LEFT,
        })
      );
      continue;
    }

    const h4Match = line.match(/^####\s*(.+)/);
    if (h4Match) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: stripResidualMarkdown(h4Match[1]),
              bold: true,
              size: 22,
              font: FONT_DISPLAY,
              color: TEXT_BODY,
            }),
          ],
          spacing: { before: 120, after: 60 },
          alignment: AlignmentType.LEFT,
        })
      );
      continue;
    }

    // Numbered section headings (e.g. "1. Title", "2.3. Title")
    const sectionMatch = line.match(/^(\d+(?:\.\d+)*)\.\s+(.+)/);
    if (sectionMatch && !line.match(/^\d+\.\s+[a-zа-я]/)) {
      // Only treat as header if first word is capitalized
      const title = sectionMatch[2];
      if (title[0] === title[0].toUpperCase() && title[0] !== title[0].toLowerCase()) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: stripResidualMarkdown(`${sectionMatch[1]}. ${title}`),
                bold: true,
                size: 24,
                font: FONT_DISPLAY,
                color: TEXT_HEAD,
              }),
            ],
            spacing: { before: 200, after: 100 },
            alignment: AlignmentType.LEFT,
          })
        );
        continue;
      }
    }

    // Bullet/list items
    const bulletMatch = line.match(/^[\s]*[-•*]\s+(.+)/);
    if (bulletMatch) {
      // Demote leading "**Label:**" bold markers in bullets — the LLM
      // routinely emits them and they make every item visually shout.
      const demoted = bulletMatch[1].replace(/^\*\*([^*\n]+?):\*\*(\s*)/, "$1:$2");
      paragraphs.push(
        new Paragraph({
          children: parseInlineFormatting(demoted),
          numbering: { reference: BULLET_REF, level: 0 },
          spacing: { after: 40 },
          alignment: AlignmentType.JUSTIFIED,
        })
      );
      continue;
    }

    // Numbered list items
    const numListMatch = line.match(/^[\s]*(\d+)\.\s+([a-zа-я].+)/);
    if (numListMatch) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${numListMatch[1]}. `,
              font: FONT_BODY,
              size: 22,
            }),
            ...parseInlineFormatting(numListMatch[2]),
          ],
          spacing: { after: 40 },
          indent: { left: 360 },
          alignment: AlignmentType.JUSTIFIED,
        })
      );
      continue;
    }

    // Blockquote (lines starting with >)
    if (line.match(/^>\s?/)) {
      // Collect consecutive blockquote lines
      const quoteLines: string[] = [line.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && lines[i + 1].match(/^>\s?/)) {
        i++;
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
      }
      const quoteText = quoteLines.join(" ").replace(/\s+/g, " ").trim();
      // Remove wrapping quotes if present
      const cleanedQuote = quoteText.replace(/^["«]|["»]$/g, "").trim();

      // Use a single-cell table for reliable background shading
      paragraphs.push(
        new Table({
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: "«",
                          italics: true,
                          font: FONT_BODY,
                          size: 21,
                          color: "374151",
                        }),
                        ...parseQuoteFormatting(cleanedQuote),
                        new TextRun({
                          text: "»",
                          italics: true,
                          font: FONT_BODY,
                          size: 21,
                          color: "374151",
                        }),
                      ],
                      alignment: AlignmentType.JUSTIFIED,
                    }),
                  ],
                  borders: {
                    top: { style: BorderStyle.NONE, size: 0 },
                    bottom: { style: BorderStyle.NONE, size: 0 },
                    right: { style: BorderStyle.NONE, size: 0 },
                    left: { style: BorderStyle.SINGLE, size: 8, color: BORDER_LIGHT },
                  },
                  margins: { top: 80, bottom: 80, left: 200, right: 120 },
                  width: { size: 100, type: WidthType.PERCENTAGE },
                }),
              ],
            }),
          ],
          width: { size: 100, type: WidthType.PERCENTAGE },
        })
      );
      continue;
    }

    // Horizontal rule
    if (line.match(/^[-*_]{3,}$/)) {
      paragraphs.push(
        new Paragraph({
          children: [],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
          },
          spacing: { before: 120, after: 120 },
        })
      );
      continue;
    }

    // Regular paragraph
    paragraphs.push(
      new Paragraph({
        children: parseInlineFormatting(line),
        spacing: { after: 80 },
        alignment: AlignmentType.JUSTIFIED,
      })
    );
  }

  // Flush remaining table
  if (inTable && tableLines.length > 0) {
    paragraphs.push(...parseTable(tableLines));
  }

  return paragraphs;
}

/* ── Inline formatting parser ── */

function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Remove [doc:N] references and normalize inline markdown glitches
  const cleaned = normalizeMarkdownInput(
    text.replace(/\[doc:\d+\]/g, "").replace(/\[[\w\s.-]+\.(docx?|pdf|xlsx?)\]/gi, "")
  );

  // Pattern: **bold**, *italic*, ***bold italic***, `code`
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    if (match[2]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[2]), bold: true, italics: true, font: FONT_BODY, size: 22 }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[3]), bold: true, font: FONT_BODY, size: 22 }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[4]), italics: true, font: FONT_BODY, size: 22 }));
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[5], font: "IBM Plex Mono", size: 20, shading: { type: ShadingType.CLEAR, fill: "F3F4F6" } }));
    } else if (match[6]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[6]), font: FONT_BODY, size: 22 }));
    }
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text: stripResidualMarkdown(cleaned), font: FONT_BODY, size: 22 }));
  }

  return runs;
}

/* ── Blockquote inline formatting (italic + muted color) ── */

function parseQuoteFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const cleaned = normalizeMarkdownInput(
    text.replace(/\[doc:\d+\]/g, "").replace(/\[[\w\s.-]+\.(docx?|pdf|xlsx?)\]/gi, "")
  );

  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    if (match[2]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[2]), bold: true, italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[3]), bold: true, italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[4]), italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[5], italics: true, font: "IBM Plex Mono", size: 20, color: "374151" }));
    } else if (match[6]) {
      runs.push(new TextRun({ text: stripResidualMarkdown(match[6]), italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    }
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text: stripResidualMarkdown(cleaned), italics: true, font: FONT_BODY, size: 21, color: "374151" }));
  }

  return runs;
}

/* ── Table parser ── */

function parseTable(lines: string[]): BlockElement[] {
  if (lines.length < 2) return [];

  // Parse header
  const headerCells = lines[0]
    .split("|")
    .filter((c) => c.trim())
    .map((c) => c.trim());

  // Skip separator line (|---|---|)
  const dataStartIndex = lines[1]?.match(/^[\s|:-]+$/) ? 2 : 1;

  const rows: string[][] = [];
  for (let i = dataStartIndex; i < lines.length; i++) {
    const cells = lines[i]
      .split("|")
      .filter((c) => c.trim() !== "" || c.includes(" "))
      .map((c) => c.trim());
    if (cells.length > 0) rows.push(cells);
  }

  const colCount = headerCells.length;

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      // Header row
      new TableRow({
        children: headerCells.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: stripResidualMarkdown(cell),
                      bold: true,
                      font: FONT_BODY,
                      size: 20,
                      color: TEXT_BODY,
                    }),
                  ],
                  alignment: AlignmentType.LEFT,
                }),
              ],
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: TEXT_BODY },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: TEXT_BODY },
                left: { style: BorderStyle.NONE, size: 0 },
                right: { style: BorderStyle.NONE, size: 0 },
              },
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
            })
        ),
      }),
      // Data rows
      ...rows.map(
        (row) =>
          new TableRow({
            children: Array.from({ length: colCount }, (_, colIdx) => {
              const cellText = row[colIdx] || "";
              return new TableCell({
                children: [
                  new Paragraph({
                    children: parseInlineFormatting(cellText),
                    alignment: AlignmentType.LEFT,
                  }),
                ],
                borders: {
                  top: { style: BorderStyle.NONE, size: 0 },
                  bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_LIGHT },
                  left: { style: BorderStyle.NONE, size: 0 },
                  right: { style: BorderStyle.NONE, size: 0 },
                },
                margins: { top: 60, bottom: 60, left: 100, right: 100 },
              });
            }),
          })
      ),
    ],
  });

  return [
    new Paragraph({ spacing: { before: 120 } }),
    table,
    new Paragraph({ spacing: { after: 120 } }),
  ];
}

/* ── Remove sources section from answer ── */

function stripSourcesSection(text: string): string {
  // Remove "Источники:", "ИСТОЧНИКИ", "Sources:" sections
  return text.replace(/\n+(?:#{0,3}\s*)?(?:Источники|ИСТОЧНИКИ|Sources)\s*:?\s*\n[\s\S]*$/i, "").trim();
}

/* ── Markdown normalization (mirrors chat-side rules) ── */

function normalizeMarkdownInput(text: string): string {
  if (!text) return text;
  let t = text;

  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(/[\u00A0\u2007\u202F]/g, " ");
  t = t.replace(/^[ \t]+(?=#{1,6})/gm, "");
  t = t.replace(/(^|\n)\\(#{1,6})/g, "$1$2");
  // `##Text` without separating space → `## Text`
  t = t.replace(/^(#{1,6})(?=\S)/gm, "$1 ");
  // Closed-ATX trailing hashes: `## Title ##` → `## Title`
  t = t.replace(/^(#{1,6}\s+.+?)\s+#+\s*$/gm, "$1");
  // Heading text wrapped in `**...**`
  t = t.replace(/^(#{1,6})\s+\*\*\s*(.+?)\s*\*\*\s*$/gm, "$1 $2");
  // `** text **` / `* text *` with stray inner whitespace
  t = t.replace(/\*\*[ \t]+([^*\n]+?)[ \t]+\*\*/g, "**$1**");
  t = t.replace(/(^|[^*])\*[ \t]+([^*\n]+?)[ \t]+\*(?!\*)/g, "$1*$2*");

  // Drop orphan `**` per line
  t = t.split("\n").map((line) => {
    const occurrences = (line.match(/\*\*/g) || []).length;
    if (occurrences % 2 === 1) {
      let seen = 0;
      return line.replace(/\*\*/g, () => (++seen === occurrences ? "" : "**"));
    }
    return line;
  }).join("\n");

  return t;
}

/** Strip markdown tokens that survived inline parsing (defence-in-depth). */
function stripResidualMarkdown(text: string): string {
  let s = text;
  s = s.replace(/(^|\n)\s*#{1,6}\s+/g, "$1");
  s = s.replace(/\*{2,3}/g, "");
  s = s.replace(/~~/g, "");
  return s;
}

/* ── Main DOCX generator ── */

async function generateDocx(question: string, answer: string): Promise<Buffer> {
  const now = new Date();
  const dateStr = now.toLocaleDateString(DATE_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Clean answer: strip sources section, then normalize markdown so header
  // markers and bold markers parse reliably (no literal `##` / `**` leaking).
  const cleanedAnswer = normalizeMarkdownInput(stripSourcesSection(answer));

  const headerChildren: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: "СнабЧат",
          bold: true,
          font: FONT_DISPLAY,
          size: 20,
          color: TEXT_HEAD,
        }),
      ],
      alignment: AlignmentType.LEFT,
      spacing: { after: 0 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_LIGHT },
      },
    }),
  ];

  // Build document body
  const bodyChildren: BlockElement[] = [];

  // Question block
  bodyChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "ВОПРОС",
          bold: true,
          font: FONT_DISPLAY,
          size: 18,
          color: TEXT_MUTED,
          characterSpacing: 40,
        }),
      ],
      spacing: { before: 120, after: 60 },
    })
  );

  bodyChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: question,
          font: FONT_BODY,
          size: 22,
          italics: true,
          color: "4B5563",
        }),
      ],
      spacing: { after: 40 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 3, color: BORDER_LIGHT, space: 8 },
      },
      indent: { left: 200 },
    })
  );

  // Separator
  bodyChildren.push(
    new Paragraph({
      children: [],
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_LIGHT },
      },
      spacing: { before: 160, after: 160 },
    })
  );

  // Answer heading
  bodyChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "ОТВЕТ",
          bold: true,
          font: FONT_DISPLAY,
          size: 18,
          color: TEXT_MUTED,
          characterSpacing: 40,
        }),
      ],
      spacing: { after: 120 },
    })
  );

  // Parse answer content
  const answerParagraphs = parseMarkdownToParagraphs(cleanedAnswer);
  bodyChildren.push(...answerParagraphs);

  // Footer separator + date
  bodyChildren.push(
    new Paragraph({
      children: [],
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_LIGHT },
      },
      spacing: { before: 240, after: 80 },
    })
  );

  bodyChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Дата: ${dateStr}`,
          font: FONT_BODY,
          size: 16,
          color: TEXT_MUTED,
        }),
      ],
      alignment: AlignmentType.RIGHT,
      spacing: { after: 40 },
    })
  );

  // Create document
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: FONT_BODY,
            size: 22,
            color: TEXT_BODY,
          },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: BULLET_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "—", // em dash
              alignment: AlignmentType.LEFT,
              style: {
                run: { font: FONT_BODY, size: 22, color: TEXT_MUTED },
                paragraph: { indent: { left: 360, hanging: 220 } },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          titlePage: true,
          page: {
            margin: {
              top: 1134, // 2cm
              right: 1134,
              bottom: 1134,
              left: 1701, // 3cm
            },
          },
        },
        headers: {
          first: new Header({
            children: headerChildren,
          }),
          default: new Header({
            children: [],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Документ подготовлен СнабЧат · Дирекция по закупкам",
                    font: FONT_BODY,
                    size: 16,
                    color: TEXT_MUTED,
                  }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        children: bodyChildren,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}

/* ── Filename generator (up to 4 meaningful Russian words) ── */

// Filename helpers moved to ../lib/export-filenames.ts (PR #5).

/* ── Strip markdown formatting from cell text ── */

function stripMarkdown(text: string): string {
  return text
    .replace(/\[doc:\d+\]/g, "")                          // [doc:N] references
    .replace(/\[[\w\s.\-]+\.(docx?|pdf|xlsx?)\]/gi, "")   // [file.docx] references
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")                  // ***bold italic***
    .replace(/\*\*(.+?)\*\*/g, "$1")                      // **bold**
    .replace(/\*(.+?)\*/g, "$1")                           // *italic*
    .replace(/~~(.+?)~~/g, "$1")                           // ~~strikethrough~~
    .replace(/`(.+?)`/g, "$1")                             // `code`
    .trim();
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

/* ── POST /api/export — DOCX export ── */

router.post("/api/export", async (req: Request, res: Response) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { question, answer } = req.body;

    if (!question || !answer) {
      return res.status(400).json({ error: "question and answer are required" });
    }

    const buffer = await generateDocx(question, answer);

    const filename = generateDocxFilename(question);
    const encodedFilename = encodeURIComponent(filename);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      // ASCII fallback for browsers that cannot decode UTF-8 filename*; same naming
      // policy as the primary name — date prefix, no brand.
      `attachment; filename="${asciiFilename("docx")}"; filename*=UTF-8''${encodedFilename}`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("DOCX export error:", error);
    return res.status(500).json({ error: "Failed to generate document" });
  }
});

/* ── POST /api/export-excel — XLSX export ── */

router.post("/api/export-excel", async (req: Request, res: Response) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { question, answer } = req.body;

    if (!answer) {
      return res.status(400).json({ error: "answer is required" });
    }

    const tables = parseMarkdownTables(answer);

    if (tables.length === 0) {
      return res.status(400).json({ error: "No tables found in answer" });
    }

    const workbook = new ExcelJS.Workbook();

    for (const table of tables) {
      const sheetName = table.name.slice(0, 31);
      const worksheet = workbook.addWorksheet(sheetName);

      for (const row of table.rows) {
        const typedRow = row.map((cell) => {
          const clean = stripMarkdown(cell);
          if (clean.startsWith("=")) {
            return { formula: clean.slice(1) };
          }
          const num = parseNumericValue(clean);
          return num !== null ? num : clean;
        });
        worksheet.addRow(typedRow);
      }

      // Auto-size columns
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

    const xlsxBuffer = await workbook.xlsx.writeBuffer();

    const filename = generateXlsxFilename(question || "Таблица");
    const encodedFilename = encodeURIComponent(filename);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFilename("xlsx")}"; filename*=UTF-8''${encodedFilename}`
    );
    return res.send(Buffer.from(xlsxBuffer));
  } catch (error) {
    console.error("Excel export error:", error);
    return res.status(500).json({ error: "Failed to generate Excel file" });
  }
});

export default router;