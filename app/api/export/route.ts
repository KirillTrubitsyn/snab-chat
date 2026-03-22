import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  AlignmentType,
  BorderStyle,
  Header,
  Footer,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  ISectionOptions,
} from "docx";

type BlockElement = Paragraph | Table;

/* ── Brand constants ── */

const BRAND_NAVY = "003A7A";
const BRAND_CYAN = "0099CC";
const FONT_DISPLAY = "Plus Jakarta Sans";
const FONT_BODY = "Source Sans 3";
const DATE_LOCALE = "ru-RU";

/* ── Logo loader ── */

function loadLogo(): Buffer | null {
  try {
    const logoPath = path.join(process.cwd(), "public", "icons", "icon-192.png");
    return fs.readFileSync(logoPath);
  } catch {
    return null;
  }
}

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

    // Headers
    const h1Match = line.match(/^# (.+)/);
    if (h1Match) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: h1Match[1],
              bold: true,
              size: 28,
              font: FONT_DISPLAY,
              color: BRAND_NAVY,
            }),
          ],
          spacing: { before: 240, after: 120 },
          alignment: AlignmentType.LEFT,
        })
      );
      continue;
    }

    const h2Match = line.match(/^## (.+)/);
    if (h2Match) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: h2Match[1],
              bold: true,
              size: 26,
              font: FONT_DISPLAY,
              color: BRAND_NAVY,
            }),
          ],
          spacing: { before: 200, after: 100 },
          alignment: AlignmentType.LEFT,
        })
      );
      continue;
    }

    const h3Match = line.match(/^### (.+)/);
    if (h3Match) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: h3Match[1],
              bold: true,
              size: 24,
              font: FONT_DISPLAY,
              color: BRAND_NAVY,
            }),
          ],
          spacing: { before: 160, after: 80 },
          alignment: AlignmentType.LEFT,
        })
      );
      continue;
    }

    const h4Match = line.match(/^#### (.+)/);
    if (h4Match) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: h4Match[1],
              bold: true,
              size: 22,
              font: FONT_DISPLAY,
              color: BRAND_NAVY,
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
                text: `${sectionMatch[1]}. ${title}`,
                bold: true,
                size: 24,
                font: FONT_DISPLAY,
                color: BRAND_NAVY,
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
      paragraphs.push(
        new Paragraph({
          children: parseInlineFormatting(bulletMatch[1]),
          bullet: { level: 0 },
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

      paragraphs.push(
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
          spacing: { before: 120, after: 120 },
          indent: { left: 480, right: 240 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: BRAND_CYAN, space: 8 },
          },
          shading: { type: ShadingType.CLEAR, fill: "F0F7FC" },
          alignment: AlignmentType.JUSTIFIED,
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
  // Remove [doc:N] references
  const cleaned = text.replace(/\[doc:\d+\]/g, "").replace(/\[[\w\s.-]+\.(docx?|pdf|xlsx?)\]/gi, "");

  // Pattern: **bold**, *italic*, ***bold italic***, `code`
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    if (match[2]) {
      // bold italic
      runs.push(new TextRun({ text: match[2], bold: true, italics: true, font: FONT_BODY, size: 22 }));
    } else if (match[3]) {
      // bold
      runs.push(new TextRun({ text: match[3], bold: true, font: FONT_BODY, size: 22 }));
    } else if (match[4]) {
      // italic
      runs.push(new TextRun({ text: match[4], italics: true, font: FONT_BODY, size: 22 }));
    } else if (match[5]) {
      // code
      runs.push(new TextRun({ text: match[5], font: "IBM Plex Mono", size: 20, shading: { type: ShadingType.CLEAR, fill: "F3F4F6" } }));
    } else if (match[6]) {
      // plain text
      runs.push(new TextRun({ text: match[6], font: FONT_BODY, size: 22 }));
    }
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text: cleaned, font: FONT_BODY, size: 22 }));
  }

  return runs;
}

/* ── Blockquote inline formatting (italic + muted color) ── */

function parseQuoteFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const cleaned = text.replace(/\[doc:\d+\]/g, "").replace(/\[[\w\s.-]+\.(docx?|pdf|xlsx?)\]/gi, "");

  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true, italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], bold: true, italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[5], italics: true, font: "IBM Plex Mono", size: 20, color: "374151" }));
    } else if (match[6]) {
      runs.push(new TextRun({ text: match[6], italics: true, font: FONT_BODY, size: 21, color: "374151" }));
    }
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text: cleaned, italics: true, font: FONT_BODY, size: 21, color: "374151" }));
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
                      text: cell,
                      bold: true,
                      font: FONT_BODY,
                      size: 20,
                      color: "FFFFFF",
                    }),
                  ],
                  alignment: AlignmentType.CENTER,
                }),
              ],
              shading: { type: ShadingType.CLEAR, fill: BRAND_NAVY },
            })
        ),
      }),
      // Data rows
      ...rows.map(
        (row, rowIdx) =>
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
                shading: rowIdx % 2 === 1 ? { type: ShadingType.CLEAR, fill: "F5F5F0" } : undefined,
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

/* ── Main DOCX generator ── */

async function generateDocx(question: string, answer: string): Promise<Buffer> {
  const logo = loadLogo();
  const now = new Date();
  const dateStr = now.toLocaleDateString(DATE_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Clean answer
  const cleanedAnswer = stripSourcesSection(answer);

  // Build header with logo and brand name
  const headerChildren: Paragraph[] = [];

  if (logo) {
    headerChildren.push(
      new Paragraph({
        children: [
          new ImageRun({
            data: logo,
            transformation: { width: 36, height: 36 },
            type: "png",
          }),
        ],
        alignment: AlignmentType.LEFT,
        spacing: { after: 0 },
      })
    );
  }

  headerChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "Снаб",
          bold: true,
          font: FONT_DISPLAY,
          size: 20,
          color: BRAND_NAVY,
        }),
        new TextRun({
          text: "Чат",
          bold: true,
          font: FONT_DISPLAY,
          size: 20,
          color: BRAND_CYAN,
        }),
      ],
      alignment: AlignmentType.LEFT,
      spacing: { after: 0 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
      },
    })
  );

  // Build document body
  const bodyChildren: BlockElement[] = [];

  // Question block
  bodyChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "Вопрос",
          bold: true,
          font: FONT_DISPLAY,
          size: 22,
          color: BRAND_CYAN,
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
        left: { style: BorderStyle.SINGLE, size: 3, color: BRAND_CYAN, space: 8 },
      },
      indent: { left: 200 },
    })
  );

  // Separator
  bodyChildren.push(
    new Paragraph({
      children: [],
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
      },
      spacing: { before: 160, after: 160 },
    })
  );

  // Answer heading
  bodyChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "Ответ",
          bold: true,
          font: FONT_DISPLAY,
          size: 22,
          color: BRAND_NAVY,
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
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
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
          size: 18,
          italics: true,
          color: "9CA3AF",
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
          },
        },
      },
    },
    sections: [
      {
        properties: {
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
          default: new Header({
            children: headerChildren,
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Документ подготовлен ",
                    font: FONT_BODY,
                    size: 16,
                    italics: true,
                    color: "9CA3AF",
                  }),
                  new TextRun({
                    text: "Снаб",
                    bold: true,
                    font: FONT_DISPLAY,
                    size: 16,
                    color: BRAND_NAVY,
                  }),
                  new TextRun({
                    text: "Чат",
                    bold: true,
                    font: FONT_DISPLAY,
                    size: 16,
                    color: BRAND_CYAN,
                  }),
                  new TextRun({
                    text: " · Дирекция по ресурсному обеспечению",
                    font: FONT_BODY,
                    size: 16,
                    italics: true,
                    color: "9CA3AF",
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

const STOP_WORDS = new Set([
  "в", "на", "по", "с", "и", "а", "но", "или", "что", "как", "для", "из",
  "от", "до", "за", "при", "не", "ли", "бы", "же", "это", "то", "все",
  "он", "она", "они", "мы", "вы", "его", "её", "их", "мне", "нам", "вам",
  "о", "об", "у", "к", "ко", "та", "те", "тот", "эта", "эти", "этот",
  "какой", "какая", "какие", "чем", "кто", "где", "когда", "почему",
  "есть", "быть", "был", "была", "были", "будет", "может", "можно",
  "нужно", "надо", "ещё", "еще", "уже", "так", "очень", "более",
  "скажи", "расскажи", "объясни", "опиши", "подскажи", "покажи",
  "пожалуйста", "какой", "какая", "какие", "какое",
]);

function generateFilename(question: string): string {
  // Extract meaningful words from question
  const words = question
    .replace(/[^\wа-яА-ЯёЁ\s-]/g, "")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const selected = words.slice(0, 4);

  if (selected.length === 0) {
    return `СнабЧат-${new Date().toISOString().slice(0, 10)}.docx`;
  }

  // Capitalize first word
  selected[0] = selected[0].charAt(0).toUpperCase() + selected[0].slice(1);

  return `${selected.join(" ")}.docx`;
}

/* ── API handler ── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { question, answer } = body;

    if (!question || !answer) {
      return NextResponse.json(
        { error: "question and answer are required" },
        { status: 400 }
      );
    }

    const buffer = await generateDocx(question, answer);

    const filename = generateFilename(question);
    const encodedFilename = encodeURIComponent(filename);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="snabchat.docx"; filename*=UTF-8''${encodedFilename}`,
      },
    });
  } catch (error) {
    console.error("DOCX export error:", error);
    return NextResponse.json(
      { error: "Failed to generate document" },
      { status: 500 }
    );
  }
}
