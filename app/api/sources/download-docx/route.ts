import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import {
  getInviteCodeFromHeader,
  validateInviteCode,
  isAdminCode,
  getAdminName,
  type InviteCode,
} from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ImageRun,
  AlignmentType,
  BorderStyle,
  TableOfContents,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
  Tab,
  TabStopType,
  TabStopPosition,
} from "docx";
import * as fs from "fs";
import * as path from "path";

// Brand colors
const BRAND_BLUE = "1E40AF";
const BRAND_LIGHT = "93C5FD";
const TEXT_COLOR = "1F2937";
const META_COLOR = "6B7280";

/**
 * Strip metadata header lines like [Применяется к: ...] [Документ: ...] → [...]
 * These appear at the start of chunks and before sections.
 */
function stripMetaLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Remove lines that are purely metadata tags
      if (/^\[Применяется к:.*\]\s*\[Документ:.*\](\s*→\s*\[.*\])?\s*$/.test(trimmed)) {
        return false;
      }
      return true;
    })
    .join("\n");
}

/**
 * Parse markdown into structured elements for docx generation
 */
function parseMarkdown(md: string): Array<{
  type: "h1" | "h2" | "h3" | "h4" | "paragraph" | "bullet" | "numbered" | "separator";
  text: string;
  bold?: boolean;
}> {
  const elements: Array<{
    type: "h1" | "h2" | "h3" | "h4" | "paragraph" | "bullet" | "numbered" | "separator";
    text: string;
    bold?: boolean;
  }> = [];

  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      elements.push({ type: "separator", text: "" });
      i++;
      continue;
    }

    // Headers
    if (trimmed.startsWith("#### ")) {
      elements.push({ type: "h4", text: trimmed.replace(/^####\s+/, "").replace(/\*\*/g, "") });
      i++;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      elements.push({ type: "h3", text: trimmed.replace(/^###\s+/, "").replace(/\*\*/g, "") });
      i++;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      elements.push({ type: "h2", text: trimmed.replace(/^##\s+/, "").replace(/\*\*/g, "") });
      i++;
      continue;
    }
    if (trimmed.startsWith("# ")) {
      elements.push({ type: "h1", text: trimmed.replace(/^#\s+/, "").replace(/\*\*/g, "") });
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*+]\s+/.test(trimmed)) {
      elements.push({
        type: "bullet",
        text: trimmed.replace(/^[-*+]\s+/, ""),
      });
      i++;
      continue;
    }

    // Numbered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      elements.push({
        type: "numbered",
        text: trimmed.replace(/^\d+[.)]\s+/, ""),
      });
      i++;
      continue;
    }

    // Regular paragraph
    elements.push({ type: "paragraph", text: trimmed });
    i++;
  }

  return elements;
}

/**
 * Convert inline markdown (bold, italic) into TextRun array
 */
function parseInlineFormatting(text: string, defaultSize: number = 22): TextRun[] {
  const runs: TextRun[] = [];
  // Pattern: **bold** or *italic* or ***bold-italic***
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      runs.push(
        new TextRun({
          text: text.slice(lastIndex, match.index),
          size: defaultSize,
          color: TEXT_COLOR,
          font: "Calibri",
        })
      );
    }

    if (match[2]) {
      // Bold italic
      runs.push(
        new TextRun({
          text: match[2],
          bold: true,
          italics: true,
          size: defaultSize,
          color: TEXT_COLOR,
          font: "Calibri",
        })
      );
    } else if (match[3]) {
      // Bold
      runs.push(
        new TextRun({
          text: match[3],
          bold: true,
          size: defaultSize,
          color: TEXT_COLOR,
          font: "Calibri",
        })
      );
    } else if (match[4]) {
      // Italic
      runs.push(
        new TextRun({
          text: match[4],
          italics: true,
          size: defaultSize,
          color: TEXT_COLOR,
          font: "Calibri",
        })
      );
    } else if (match[5]) {
      // Code
      runs.push(
        new TextRun({
          text: match[5],
          font: "Consolas",
          size: defaultSize - 2,
          color: BRAND_BLUE,
          shading: { type: "clear" as any, fill: "F0F4FF", color: "auto" },
        })
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    runs.push(
      new TextRun({
        text: text.slice(lastIndex),
        size: defaultSize,
        color: TEXT_COLOR,
        font: "Calibri",
      })
    );
  }

  if (runs.length === 0) {
    runs.push(
      new TextRun({
        text,
        size: defaultSize,
        color: TEXT_COLOR,
        font: "Calibri",
      })
    );
  }

  return runs;
}

function buildDocxParagraphs(
  elements: ReturnType<typeof parseMarkdown>
): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const el of elements) {
    switch (el.type) {
      case "h1":
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: el.text,
                bold: true,
                size: 36,
                color: BRAND_BLUE,
                font: "Calibri",
              }),
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 360, after: 200 },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                color: BRAND_LIGHT,
                space: 4,
              },
            },
          })
        );
        break;

      case "h2":
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: el.text,
                bold: true,
                size: 28,
                color: BRAND_BLUE,
                font: "Calibri",
              }),
            ],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 300, after: 120 },
          })
        );
        break;

      case "h3":
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: el.text,
                bold: true,
                size: 24,
                color: "374151",
                font: "Calibri",
              }),
            ],
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 240, after: 100 },
          })
        );
        break;

      case "h4":
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: el.text,
                bold: true,
                italics: true,
                size: 22,
                color: "4B5563",
                font: "Calibri",
              }),
            ],
            heading: HeadingLevel.HEADING_4,
            spacing: { before: 200, after: 80 },
          })
        );
        break;

      case "bullet":
        paragraphs.push(
          new Paragraph({
            children: parseInlineFormatting(el.text),
            bullet: { level: 0 },
            spacing: { before: 40, after: 40 },
          })
        );
        break;

      case "numbered":
        paragraphs.push(
          new Paragraph({
            children: parseInlineFormatting(el.text),
            numbering: { reference: "default-numbering", level: 0 },
            spacing: { before: 40, after: 40 },
          })
        );
        break;

      case "separator":
        paragraphs.push(
          new Paragraph({
            children: [],
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 4,
                color: "E5E7EB",
                space: 8,
              },
            },
            spacing: { before: 200, after: 200 },
          })
        );
        break;

      case "paragraph":
        paragraphs.push(
          new Paragraph({
            children: parseInlineFormatting(el.text),
            spacing: { before: 80, after: 80, line: 300 },
          })
        );
        break;
    }
  }

  return paragraphs;
}

export async function GET(req: NextRequest) {
  // Auth (same as download route)
  let invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    const tokenParam = req.nextUrl.searchParams.get("token");
    if (tokenParam) {
      const code = decodeURIComponent(tokenParam);
      if (isAdminCode(code)) {
        invite = {
          id: `admin-${code.toUpperCase()}`,
          code: code.toUpperCase(),
          name: getAdminName(code) ?? "Админ",
          organization: "Админ",
          uses_remaining: null,
          device_limit: null,
          is_active: true,
          created_at: new Date().toISOString(),
        } as InviteCode;
      } else {
        invite = await validateInviteCode(code);
      }
    }
  }
  if (!invite) return unauthorizedResponse();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Get source
  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select("id, filename, mime_type, storage_path")
    .eq("id", id)
    .single();

  if (sourceError || !source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  // Get markdown content — either from storage or from chunks
  let markdown = "";

  if (source.storage_path) {
    const { data: fileData } = await supabase.storage
      .from("documents")
      .download(source.storage_path);
    if (fileData) {
      markdown = await fileData.text();
    }
  }

  if (!markdown) {
    const { data: chunks } = await supabase
      .from("chunks")
      .select("content, chunk_index")
      .eq("source_id", source.id)
      .order("chunk_index", { ascending: true });

    if (chunks && chunks.length > 0) {
      markdown = chunks.map((c) => c.content).join("\n\n");
    }
  }

  if (!markdown) {
    return NextResponse.json({ error: "No content available" }, { status: 404 });
  }

  // Clean markdown
  const cleanMd = stripMetaLines(markdown);
  const elements = parseMarkdown(cleanMd);

  // Load logo
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.join(process.cwd(), "public", "snabchat-logo.png");
    logoBuffer = fs.readFileSync(logoPath);
  } catch {
    // Logo not available — proceed without it
  }

  // Build document title from filename
  const docTitle = source.filename
    .replace(/\.md$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c: string) => c.toUpperCase());

  // Build header with logo
  const headerChildren: Paragraph[] = [];
  if (logoBuffer) {
    headerChildren.push(
      new Paragraph({
        children: [
          new ImageRun({
            data: logoBuffer,
            transformation: { width: 100, height: 100 },
            type: "png",
          }),
          new TextRun({
            text: "\t",
            font: "Calibri",
            size: 16,
          }),
          new TextRun({
            text: "СнабЧат",
            font: "Calibri",
            bold: true,
            size: 20,
            color: BRAND_BLUE,
          }),
          new TextRun({
            text: "  |  База знаний Дирекции по закупкам",
            font: "Calibri",
            size: 16,
            color: META_COLOR,
          }),
        ],
        tabStops: [
          {
            type: TabStopType.LEFT,
            position: 2400,
          },
        ],
        spacing: { after: 100 },
        border: {
          bottom: {
            style: BorderStyle.SINGLE,
            size: 4,
            color: BRAND_LIGHT,
            space: 6,
          },
        },
      })
    );
  } else {
    headerChildren.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "СнабЧат",
            font: "Calibri",
            bold: true,
            size: 20,
            color: BRAND_BLUE,
          }),
          new TextRun({
            text: "  |  База знаний Дирекции по закупкам",
            font: "Calibri",
            size: 16,
            color: META_COLOR,
          }),
        ],
        spacing: { after: 100 },
        border: {
          bottom: {
            style: BorderStyle.SINGLE,
            size: 4,
            color: BRAND_LIGHT,
            space: 6,
          },
        },
      })
    );
  }

  // Build title page elements
  const titleParagraphs: Paragraph[] = [
    // Title
    new Paragraph({
      children: [
        new TextRun({
          text: docTitle,
          bold: true,
          size: 40,
          color: BRAND_BLUE,
          font: "Calibri",
        }),
      ],
      spacing: { before: 200, after: 80 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 8,
          color: BRAND_LIGHT,
          space: 8,
        },
      },
    }),
    // Date
    new Paragraph({
      children: [
        new TextRun({
          text: `Документ из базы знаний СнабЧат  •  ${new Date().toLocaleDateString("ru-RU", {
            day: "2-digit",
            month: "long",
            year: "numeric",
          })}`,
          size: 18,
          color: META_COLOR,
          font: "Calibri",
          italics: true,
        }),
      ],
      spacing: { before: 40, after: 400 },
    }),
  ];

  // Combine all content
  const bodyParagraphs = [...titleParagraphs, ...buildDocxParagraphs(elements)];

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [
            {
              level: 0,
              format: NumberFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: {
                paragraph: {
                  indent: { left: 720, hanging: 360 },
                },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1134, // ~2cm
              right: 1134,
              bottom: 1134,
              left: 1418, // ~2.5cm
            },
          },
        },
        headers: {
          default: new Header({ children: headerChildren }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "СнабЧат  •  ",
                    font: "Calibri",
                    size: 14,
                    color: META_COLOR,
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: "Calibri",
                    size: 14,
                    color: META_COLOR,
                  }),
                ],
                alignment: AlignmentType.CENTER,
                border: {
                  top: {
                    style: BorderStyle.SINGLE,
                    size: 2,
                    color: "E5E7EB",
                    space: 4,
                  },
                },
              }),
            ],
          }),
        },
        children: bodyParagraphs,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const docxFilename = source.filename.replace(/\.md$/, ".docx");

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(docxFilename)}"`,
    },
  });
}
