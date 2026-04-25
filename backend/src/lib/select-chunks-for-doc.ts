/**
 * Pure helper: per-document chunk selection for fetchChunksByDocument.
 *
 * Extracted from backend/src/lib/retrieval.ts to make the selection logic
 * unit-testable in isolation. The original inline loops contained a tautology
 * (`selected.length < selected.length + ...`) that ignored the running count
 * and overshot the per-document cap (audit 24.04.2026 finding High-1).
 *
 * Two strategies:
 *   (a) keyword-scoring: pick first chunk + top-N by keyword count, pad with
 *       evenly stepped chunks to fill docLimit;
 *   (b) sampling: pick first chunk + evenly stepped chunks to fill docLimit.
 *
 * Invariant: returned array length is in [0, docLimit].
 */

/** Escape regex special chars (ReDoS-safe). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ChunkLike {
  id: string;
  content: string;
}

/**
 * Select up to docLimit chunks from a single document.
 *
 * @param docChunks  All chunks of one source_filename, in chunk_index order.
 * @param docLimit   Hard upper bound on number of chunks to return.
 * @param searchQuery  If provided, applies keyword scoring; otherwise samples evenly.
 */
export function selectChunksForDoc<T extends ChunkLike>(
  docChunks: T[],
  docLimit: number,
  searchQuery?: string
): T[] {
  if (docChunks.length === 0 || docLimit <= 0) return [];
  if (docChunks.length <= docLimit) return docChunks.slice();

  if (searchQuery && searchQuery.trim().length > 0) {
    return selectByKeywordScoring(docChunks, docLimit, searchQuery);
  }
  return selectBySampling(docChunks, docLimit);
}

function selectByKeywordScoring<T extends ChunkLike>(
  docChunks: T[],
  docLimit: number,
  searchQuery: string
): T[] {
  const keywords = searchQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .map((w) => w.replace(/[.,!?;:()]/g, ""))
    .filter((w) => w.length > 0);

  const scored = docChunks.map((chunk) => {
    const lower = chunk.content.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const regex = new RegExp(escapeRegExp(kw), "gi");
      const matches = lower.match(regex);
      if (matches) score += matches.length;
    }
    return { chunk, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const firstChunk = docChunks[0];
  const topChunks = scored
    .filter((s) => s.score > 0 && s.chunk !== firstChunk)
    .slice(0, docLimit - 1)
    .map((s) => s.chunk);

  const selected: T[] = [firstChunk, ...topChunks];

  // Pad with evenly stepped chunks if we still have room under docLimit.
  // The original code compared selected.length to selected.length + offset,
  // which is constant in the running count and overshot the cap (High-1).
  if (selected.length < docLimit) {
    const ids = new Set(selected.map((c) => c.id));
    const remainingTarget = docLimit - selected.length;
    const step = Math.max(1, Math.floor(docChunks.length / (remainingTarget + 1)));
    for (let i = step; i < docChunks.length && selected.length < docLimit; i += step) {
      if (!ids.has(docChunks[i].id)) {
        selected.push(docChunks[i]);
        ids.add(docChunks[i].id);
      }
    }
  }
  return selected;
}

function selectBySampling<T extends ChunkLike>(docChunks: T[], docLimit: number): T[] {
  const selected: T[] = [docChunks[0]];
  if (docLimit > 1 && docChunks.length > 1) {
    const step = Math.max(1, Math.floor((docChunks.length - 1) / (docLimit - 1)));
    for (let i = step; i < docChunks.length && selected.length < docLimit; i += step) {
      selected.push(docChunks[i]);
    }
  }
  return selected;
}
