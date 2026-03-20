interface Chunk {
  content: string;
  index: number;
}

const TARGET_CHARS = 9000; // ~3000 tokens
const MIN_CHUNK_CHARS = 500;

export function chunkMarkdown(markdown: string): Chunk[] {
  const paragraphs = splitIntoParagraphs(markdown);
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let index = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const paraLen = para.length;

    if (currentLen + paraLen > TARGET_CHARS && currentLen >= MIN_CHUNK_CHARS) {
      chunks.push({ content: current.join("\n\n"), index });
      index++;

      // Overlap: keep the last paragraph
      const lastPara = current[current.length - 1];
      current = [lastPara];
      currentLen = lastPara.length;
    }

    current.push(para);
    currentLen += paraLen;
  }

  if (current.length > 0 && currentLen > 0) {
    chunks.push({ content: current.join("\n\n"), index });
  }

  return chunks;
}

function splitIntoParagraphs(text: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let inCodeBlock = false;

  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      buffer += line + "\n";
      continue;
    }

    if (inCodeBlock) {
      buffer += line + "\n";
      continue;
    }

    if (line.trim() === "") {
      if (buffer.trim()) {
        parts.push(buffer.trim());
      }
      buffer = "";
    } else {
      buffer += line + "\n";
    }
  }

  if (buffer.trim()) {
    parts.push(buffer.trim());
  }

  return parts;
}
