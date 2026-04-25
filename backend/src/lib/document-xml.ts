/**
 * Pure helper: render a single retrieval chunk as <document> XML for the
 * RAG context. Extracted from backend/src/routes/chat.ts so the formatter
 * is unit-testable.
 *
 * The system prompt instructs the model to read tags from XML attributes
 * to determine procurement regime (223-ФЗ vs вне 223-ФЗ). The previous
 * implementation never emitted a `tags` attribute, so that instruction
 * was dead (audit 24.04.2026 finding High-2).
 */

/** XML attribute escape: handles &, ", ', <, >. */
export function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface DocumentXmlInput {
  source_filename: string;
  chunk_index: number;
  similarity: number;
  tags: string[];
  hasScreenshots: boolean;
  /** Already-sanitized content (caller is responsible for sanitizeDocContent). */
  sanitizedContent: string;
}

/**
 * Build <document id="..." filename="..." ... tags="..." ...>BODY</document>.
 *
 * @param idx 1-based document index inside <documents>.
 */
export function buildDocumentXml(input: DocumentXmlInput, idx: number): string {
  const filename = escapeXmlAttr(input.source_filename);
  const similarity = input.similarity.toFixed(2);
  const tagsAttr = escapeXmlAttr((input.tags || []).join(" "));
  const screenshots = input.hasScreenshots ? "yes" : "no";

  return (
    `<document id="${idx}" filename="${filename}" chunk="${input.chunk_index}" ` +
    `similarity="${similarity}" tags="${tagsAttr}" has_screenshots="${screenshots}">\n` +
    `${input.sanitizedContent}\n</document>`
  );
}
