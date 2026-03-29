import type { ExtractedImage } from "./parser";

export interface ChunkImage {
  data: Buffer;
  mimeType: string;
  marker: string;
}

export interface Chunk {
  content: string;
  index: number;
  images: ChunkImage[];
}

const TARGET_CHARS = 9000; // ~3000 tokens
const MIN_CHUNK_CHARS = 500;
const MAX_CHUNK_CHARS = 15000; // hard limit for very large tables
const MAX_IMAGES_PER_CHUNK = 6; // Gemini Embedding 2 limit

/**
 * Chunk markdown and attach images to the chunks that contain their markers.
 * Each image placeholder like [СКРИНШОТ 1] gets matched to the chunk
 * that contains it.
 */
export function chunkMarkdown(
  markdown: string,
  images: ExtractedImage[] = []
): Chunk[] {
  const blocks = splitIntoBlocks(markdown);
  const rawChunks: { content: string; index: number }[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let index = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockLen = block.length;

    // If a single block exceeds MAX_CHUNK_CHARS, force-split it
    if (blockLen > MAX_CHUNK_CHARS) {
      if (current.length > 0 && currentLen > 0) {
        rawChunks.push({ content: current.join("\n\n"), index });
        index++;
        current = [];
        currentLen = 0;
      }

      const lines = block.split("\n");
      let lineBuf: string[] = [];
      let lineBufLen = 0;

      for (const line of lines) {
        if (
          lineBufLen + line.length > TARGET_CHARS &&
          lineBufLen >= MIN_CHUNK_CHARS
        ) {
          rawChunks.push({ content: lineBuf.join("\n"), index });
          index++;
          lineBuf = [];
          lineBufLen = 0;
        }
        lineBuf.push(line);
        lineBufLen += line.length;
      }

      if (lineBuf.length > 0) {
        current = [lineBuf.join("\n")];
        currentLen = lineBufLen;
      }

      continue;
    }

    if (currentLen + blockLen > TARGET_CHARS && currentLen >= MIN_CHUNK_CHARS) {
      rawChunks.push({ content: current.join("\n\n"), index });
      index++;

      // Overlap: keep the last block (but not if it's a table — too large)
      const lastBlock = current[current.length - 1];
      if (lastBlock.length < 2000 && !lastBlock.includes("| --- |")) {
        current = [lastBlock];
        currentLen = lastBlock.length;
      } else {
        current = [];
        currentLen = 0;
      }
    }

    current.push(block);
    currentLen += blockLen;
  }

  if (current.length > 0 && currentLen > 0) {
    rawChunks.push({ content: current.join("\n\n"), index });
  }

  // Attach images to chunks based on marker presence
  return rawChunks.map((chunk) => {
    const chunkImages: ChunkImage[] = [];

    for (const img of images) {
      if (chunk.content.includes(img.marker) && chunkImages.length < MAX_IMAGES_PER_CHUNK) {
        chunkImages.push({
          data: img.data,
          mimeType: img.mimeType,
          marker: img.marker,
        });
      }
    }

    return {
      content: chunk.content,
      index: chunk.index,
      images: chunkImages,
    };
  });
}

/**
 * Split markdown into semantic blocks:
 * - Tables are kept as single blocks (header + separator + rows)
 * - Code blocks are kept together
 * - Regular text is split by blank lines
 * - Image markers [СКРИНШОТ N] are kept with surrounding text
 */
function splitIntoBlocks(text: string): string[] {
  const blocks: string[] = [];
  let buffer = "";
  let inCodeBlock = false;
  let inTable = false;

  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code block toggle
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      buffer += line + "\n";
      if (!inCodeBlock && buffer.trim()) {
        blocks.push(buffer.trim());
        buffer = "";
      }
      continue;
    }

    if (inCodeBlock) {
      buffer += line + "\n";
      continue;
    }

    // Table detection
    const isTableLine = /^\|.*\|/.test(trimmed);
    const isSeparator = /^\|[\s\-:|]+\|$/.test(trimmed);

    if (isTableLine && !inTable) {
      if (buffer.trim()) {
        blocks.push(buffer.trim());
        buffer = "";
      }
      inTable = true;
      buffer = line + "\n";
      continue;
    }

    if (inTable) {
      if (isTableLine) {
        if (buffer.length > TARGET_CHARS * 0.8 && !isSeparator) {
          blocks.push(buffer.trim());
          const headerLines = buffer.split("\n").slice(0, 2);
          buffer = headerLines.join("\n") + "\n" + line + "\n";
        } else {
          buffer += line + "\n";
        }
        continue;
      } else {
        inTable = false;
        if (buffer.trim()) {
          blocks.push(buffer.trim());
          buffer = "";
        }
      }
    }

    // Regular text: split by blank lines
    // BUT: don't split image markers from surrounding text
    if (trimmed === "") {
      if (buffer.trim()) {
        blocks.push(buffer.trim());
      }
      buffer = "";
    } else {
      buffer += line + "\n";
    }
  }

  if (buffer.trim()) {
    blocks.push(buffer.trim());
  }

  return blocks;
}
