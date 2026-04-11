import { escapeXmlAttr, sanitizeDocContent } from "./sanitize.js";

/**
 * Detects whether a user query mentions SGK group organizations,
 * requiring the "Перечень компаний Общества" registry document.
 * Triggers on: entity names (ТЭЦ, ГРЭС, теплосеть), legal forms (АО, ООО),
 * group structure keywords, regime questions, etc.
 */
export const ORG_MENTION_PATTERNS = [
  /тэц|грэс|гтэс|теплосет|теплоэнерг|теплотранзит/i,
  /(?:ао|зао|пао)\s*[«"]/i,
  /ооо\s*[«"]сгк[»"]/i,
  /енисейск|кузбасс|кемеров|абакан|барнаул|новосибирск|минусинск|канск|бийск|рубцовск|приморск|рефтинск|барабинск|томь-усинск|беловск|ново-кемеровск|кузнецк/i,
  /тгк.?13|етгк|сибэко|сибэм|кемген|юстк|мтск|ртк.генерац|нтск/i,
  /сгк.?алтай|сгк.?новосибирск/i,
  /группа?\s*(сгк|компаний)|организаци.*(группы|сгк)|структур.*(сгк|группы)|филиал|дочерн/i,
  /223.?фз.*(кто|как|организац|компан|юрлиц|общество)|режим.*(закупк|организац|компан)|по какому.*(закон|режим|фз)/i,
  /перечень.*(компаний|организаций|обществ)/i,
];

export interface ChunkWithImages {
  content: string;
  source_filename: string;
  chunk_index: number;
  similarity: number;
  imageBase64: Array<{ base64: string; mimeType: string }>;
}

/**
 * Build the `<documents>` XML block from RAG-retrieved chunks.
 * Returns empty string if no chunks are provided.
 */
export function buildRagContext(chunksWithImages: ChunkWithImages[]): string {
  if (!chunksWithImages.length) return "";
  return `<documents>\n${chunksWithImages
    .map(
      (r, i) =>
        `<document id="${i + 1}" filename="${escapeXmlAttr(r.source_filename)}" chunk="${r.chunk_index}" similarity="${r.similarity.toFixed(2)}" has_screenshots="${r.imageBase64.length > 0 ? "yes" : "no"}">\n${sanitizeDocContent(r.content)}\n</document>`
    )
    .join("\n")}\n</documents>`;
}

/**
 * Build the `<uploaded_documents>` XML block for user-attached documents.
 * Truncates large documents at `maxChars` and tracks which were truncated.
 */
export function buildUploadedDocsContext(
  attachedDocuments: Array<{ filename: string; markdown: string }>,
  maxChars: number
): { xml: string; truncatedDocs: string[] } {
  const truncatedDocs: string[] = [];
  const docs = attachedDocuments.map((d, i) => {
    const wasTruncated = d.markdown.length > maxChars;
    if (wasTruncated) {
      truncatedDocs.push(d.filename);
    }
    const content = wasTruncated
      ? d.markdown.slice(0, maxChars) +
        `\n\n[... документ обрезан: показано ${maxChars} из ${d.markdown.length} символов. Для работы с оставшейся частью попросите пользователя уточнить конкретный раздел ...]`
      : d.markdown;
    return `<uploaded_document id="${i + 1}" filename="${escapeXmlAttr(d.filename)}" total_chars="${d.markdown.length}" truncated="${wasTruncated}">\n${sanitizeDocContent(content)}\n</uploaded_document>`;
  });
  return {
    xml: `<uploaded_documents>\n${docs.join("\n")}\n</uploaded_documents>`,
    truncatedDocs,
  };
}
