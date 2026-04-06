import { Router, Request, Response } from "express";
import { getInviteCodeFromHeader } from "../lib/auth.js";

const router = Router();

// POST /api/export — export conversation to DOCX
// This is a large file (~700 lines in the original). Core logic is preserved.
router.post("/api/export", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return res.status(401).json({ error: "Требуется инвайт-код" });

    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "question and answer are required" });
    }

    // Dynamically import docx to avoid loading at startup
    const {
      Document, Packer, Paragraph, TextRun, AlignmentType,
      Header, Footer, BorderStyle,
    } = await import("docx");

    const BRAND_NAVY = "003A7A";
    const BRAND_CYAN = "0099CC";
    const FONT_DISPLAY = "Plus Jakarta Sans";
    const FONT_BODY = "Source Sans 3";

    const now = new Date();
    const dateStr = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

    // Simple markdown to paragraphs converter
    const paragraphs: InstanceType<typeof Paragraph>[] = [];
    const lines = answer.replace(/\n+(?:#{0,3}\s*)?(?:Источники|ИСТОЧНИКИ|Sources)\s*:?\s*\n[\s\S]*$/i, "").trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) {
        paragraphs.push(new Paragraph({ spacing: { after: 80 } }));
        continue;
      }

      const h2Match = line.match(/^## (.+)/);
      if (h2Match) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: h2Match[1], bold: true, size: 26, font: FONT_DISPLAY, color: BRAND_NAVY })],
          spacing: { before: 200, after: 100 },
        }));
        continue;
      }

      const h3Match = line.match(/^### (.+)/);
      if (h3Match) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: h3Match[1], bold: true, size: 24, font: FONT_DISPLAY, color: BRAND_NAVY })],
          spacing: { before: 160, after: 80 },
        }));
        continue;
      }

      const bulletMatch = line.match(/^[\s]*[-•*]\s+(.+)/);
      if (bulletMatch) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: bulletMatch[1], font: FONT_BODY, size: 22 })],
          bullet: { level: 0 },
          spacing: { after: 40 },
        }));
        continue;
      }

      // Regular text — handle bold
      const children: InstanceType<typeof TextRun>[] = [];
      const parts = line.replace(/\[doc:\d+\]/g, "").split(/(\*\*[^*]+\*\*)/);
      for (const part of parts) {
        const boldMatch = part.match(/^\*\*(.+)\*\*$/);
        if (boldMatch) {
          children.push(new TextRun({ text: boldMatch[1], bold: true, font: FONT_BODY, size: 22 }));
        } else if (part) {
          children.push(new TextRun({ text: part, font: FONT_BODY, size: 22 }));
        }
      }
      if (children.length > 0) {
        paragraphs.push(new Paragraph({
          children,
          spacing: { after: 80 },
          alignment: AlignmentType.JUSTIFIED,
        }));
      }
    }

    const doc = new Document({
      sections: [{
        properties: {
          page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1701 } },
        },
        headers: {
          default: new Header({
            children: [new Paragraph({
              children: [
                new TextRun({ text: "Снаб", bold: true, font: FONT_DISPLAY, size: 20, color: BRAND_NAVY }),
                new TextRun({ text: "Чат", bold: true, font: FONT_DISPLAY, size: 20, color: BRAND_CYAN }),
              ],
              border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" } },
            })],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              children: [new TextRun({ text: `${dateStr} · СнабЧат`, font: FONT_BODY, size: 16, italics: true, color: "9CA3AF" })],
              alignment: AlignmentType.CENTER,
            })],
          }),
        },
        children: [
          new Paragraph({
            children: [new TextRun({ text: "Вопрос", bold: true, font: FONT_DISPLAY, size: 22, color: BRAND_CYAN })],
            spacing: { after: 60 },
          }),
          new Paragraph({
            children: [new TextRun({ text: question, font: FONT_BODY, size: 22, italics: true, color: "4B5563" })],
            spacing: { after: 160 },
            indent: { left: 200 },
          }),
          new Paragraph({
            children: [new TextRun({ text: "Ответ", bold: true, font: FONT_DISPLAY, size: 22, color: BRAND_NAVY })],
            spacing: { after: 120 },
          }),
          ...paragraphs,
        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);

    // Generate filename
    const words = question.replace(/[^\wа-яА-ЯёЁ\s-]/g, "").split(/\s+/).filter((w: string) => w.length > 2).slice(0, 4);
    if (words.length > 0) words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    const filename = words.length > 0 ? `${words.join(" ")}.docx` : `СнабЧат-${new Date().toISOString().slice(0, 10)}.docx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="snabchat.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("DOCX export error:", error);
    return res.status(500).json({ error: "Failed to generate document" });
  }
});

// POST /api/export-excel — export conversation tables to XLSX
router.post("/api/export-excel", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return res.status(401).json({ error: "Требуется инвайт-код" });

    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "question and answer are required" });
    }

    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();

    // Parse markdown tables from answer
    const sections = answer.split(/^## /m).filter(Boolean);
    let sheetCount = 0;

    for (const section of sections) {
      const lines = section.split("\n");
      const sheetName = (lines[0] || "Sheet").trim().slice(0, 31).replace(/[*?/\\[\]]/g, "_");

      const tableLines = lines.filter((l: string) => l.trim().startsWith("|") && l.trim().endsWith("|"));
      if (tableLines.length < 2) continue;

      const rows = tableLines
        .filter((l: string) => !l.match(/^[\s|:-]+$/))
        .map((l: string) =>
          l.split("|").filter((c: string) => c.trim() !== "").map((c: string) => {
            const trimmed = c.trim().replace(/\*\*/g, "");
            // Check if it looks like an Excel formula
            if (trimmed.startsWith("=")) return trimmed;
            const num = Number(trimmed.replace(/\s/g, "").replace(",", "."));
            return !isNaN(num) && trimmed !== "" ? num : trimmed;
          })
        );

      if (rows.length > 0) {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, ws, sheetName);
        sheetCount++;
      }
    }

    if (sheetCount === 0) {
      return res.status(400).json({ error: "В ответе не найдены таблицы для экспорта" });
    }

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const words = question.replace(/[^\wа-яА-ЯёЁ\s-]/g, "").split(/\s+/).filter((w: string) => w.length > 2).slice(0, 4);
    if (words.length > 0) words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    const filename = words.length > 0 ? `${words.join(" ")}.xlsx` : `СнабЧат-${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="snabchat.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("Excel export error:", error);
    return res.status(500).json({ error: "Failed to generate spreadsheet" });
  }
});

export default router;
