import { createServiceClient } from "./supabase";
import { embedQuery } from "./embeddings";

export interface SearchResult {
  id: string;
  content: string;
  source_filename: string;
  chunk_index: number;
  similarity: number;
  tags: string[];
}

/* ── Relevance filtering constants ── */
const SIMILARITY_THRESHOLD = 0.35;
const CLIFF_RATIO = 0.7;
const MAX_CHUNKS = 8;

export interface FilteredSearchResult {
  results: SearchResult[];
  lowConfidence: boolean;
}

/**
 * Post-filter search results by relevance:
 * 1. Drop chunks below SIMILARITY_THRESHOLD
 * 2. Detect "cliff" drops in similarity
 * 3. Cap at MAX_CHUNKS
 * 4. If all below threshold, keep best one and flag lowConfidence
 */
export function filterByRelevance(results: SearchResult[]): FilteredSearchResult {
  if (results.length === 0) {
    return { results: [], lowConfidence: true };
  }

  // Sort by similarity descending (should already be, but ensure)
  const sorted = [...results].sort((a, b) => b.similarity - a.similarity);

  // Check if even the best result is below threshold
  if (sorted[0].similarity < SIMILARITY_THRESHOLD) {
    return { results: [sorted[0]], lowConfidence: true };
  }

  const filtered: SearchResult[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    // Hard threshold
    if (sorted[i].similarity < SIMILARITY_THRESHOLD) break;
    // Cliff detection: if this result drops sharply vs previous
    if (sorted[i].similarity < sorted[i - 1].similarity * CLIFF_RATIO) break;
    // Max cap
    if (filtered.length >= MAX_CHUNKS) break;

    filtered.push(sorted[i]);
  }

  return { results: filtered, lowConfidence: false };
}

export async function hybridSearch(
  query: string,
  matchCount: number = 20,
  filterTags: string[] | null = null
): Promise<SearchResult[]> {
  const supabase = createServiceClient();
  const queryEmbedding = await embedQuery(query);

  // Convert embedding array to pgvector string format
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  console.log("hybrid_search: query =", query.slice(0, 100), "embedding dim =", queryEmbedding.length);

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: matchCount,
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: filterTags,
  });

  if (error) {
    console.error("hybrid_search error:", error);
    return [];
  }

  console.log("hybrid_search: results =", data?.length ?? 0);
  return data ?? [];
}
