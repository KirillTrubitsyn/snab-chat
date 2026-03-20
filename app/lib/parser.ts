// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  convertToMarkdown: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
};

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

  // Fallback: treat as plain text
  return buffer.toString("utf-8");
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
