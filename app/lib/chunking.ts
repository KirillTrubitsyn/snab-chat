interface Chunk {
  content: string;
  index: number;
}

const TARGET_CHARS = 9000; // ~3000 tokens
const MIN_CHUNK_CHARS = 500;
const MAX_CHUNK_CHARS = 15000; // hard limit for very large tables

export function chunkMarkdown(markdown: string): Chunk[] {
  const blocks = splitIntoBlocks(markdown);
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let index = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockLen = block.length;

    // If a single block exceeds MAX_CHUNK_CHARS, force-split it
    if (blockLen > MAX_CHUNK_CHARS) {
      // Flush current buffer first
      if (current.length > 0 && currentLen > 0) {
        chunks.push({ content: current.join("\n\n"), index });
        index++;
        current = [];
        currentLen = 0;
      }

      // Split large block by lines
      const lines = block.split("\n");
      let lineBuf: string[] = [];
      let lineBufLen = 0;

      for (const line of lines) {
        if (lineBufLen + line.length > TARGET_CHARS && lineBufLen >= MIN_CHUNK_CHARS) {
          chunks.push({ content: lineBuf.join("\n"), index });
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
      chunks.push({ content: current.join("\n\n"), index });
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
    chunks.push({ content: current.join("\n\n"), index });
  }

  return chunks;
}

/**
 * Split markdown into semantic blocks:
 * - Tables are kept as single blocks (header + separator + rows)
 * - Code blocks are kept together
 * - Regular text is split by blank lines
 */
function splitIntoBlocks(text: string): string[] {
  const blocks: string[] = [];
  let buffer = "";
  let inCodeBlock = false;
  let inTable = false;
  let tableHeader = "";

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

    // Table detection: line starts with | and contains at least one more |
    const isTableLine = /^\|.*\|/.test(trimmed);
    const isSeparator = /^\|[\s\-:|]+\|$/.test(trimmed);

    if (isTableLine && !inTable) {
      // Start of table: flush previous buffer
      if (buffer.trim()) {
        blocks.push(buffer.trim());
        buffer = "";
      }
      inTable = true;

      // Remember header for potential re-use
      if (!isSeparator) {
        tableHeader = line;
      }
      buffer = line + "\n";
      continue;
    }

    if (inTable) {
      if (isTableLine) {
        // Check if table is getting too large — split with header repetition
        if (buffer.length > TARGET_CHARS * 0.8 && !isSeparator) {
          // Push current table block
          blocks.push(buffer.trim());

          // Start new block with repeated table header
          const headerLines = buffer.split("\n").slice(0, 2);
          buffer = headerLines.join("\n") + "\n" + line + "\n";
        } else {
          buffer += line + "\n";
        }
        continue;
      } else {
        // End of table
        inTable = false;
        if (buffer.trim()) {
          blocks.push(buffer.trim());
          buffer = "";
        }
        // Process current non-table line below
      }
    }

    // Regular text: split by blank lines
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
