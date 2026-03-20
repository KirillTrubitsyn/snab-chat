import { createServiceClient } from "./supabase";
import { embedQuery } from "./embeddings";

interface SearchResult {
  id: string;
  content: string;
  source_filename: string;
  chunk_index: number;
  similarity: number;
  tags: string[];
}

export async function hybridSearch(
  query: string,
  matchCount: number = 5,
  filterTags: string[] | null = null
): Promise<SearchResult[]> {
  const supabase = createServiceClient();
  const queryEmbedding = await embedQuery(query);

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: matchCount,
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: filterTags,
  });

  if (error) {
    console.error("hybrid_search error:", error);
    return [];
  }

  return data ?? [];
}
