import type { SearchResult } from "./retrieval.js";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/rerank";
const VOYAGE_MODEL = "rerank-2.5";
const MAX_CHUNKS_TO_RERANK = 20;
const MAX_CHUNK_CHARS = 4000; // Voyage rerank-2.5 handles up to ~16K tokens per doc; 4K chars is safe

interface VoyageRerankResponse {
  data: { index: number; relevance_score: number }[];
  usage: { total_tokens: number };
}

/**
 * Voyage AI rerank-2.5 — purpose-built cross-encoder reranker.
 * Sends query + candidate chunks to Voyage API and gets back relevance scores (0–1).
 * Blends with original hybrid search score for compatibility with filterByRelevance.
 */
export async function voyageRerank(
  query: string,
  results: SearchResult[]
): Promise<SearchResult[]> {
  if (results.length <= 1) return results;

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    console.warn("[voyage-reranker] VOYAGE_API_KEY not set, skipping rerank");
    return results;
  }

  const candidates = results.slice(0, MAX_CHUNKS_TO_RERANK);
  const documents = candidates.map((r) =>
    r.content.length > MAX_CHUNK_CHARS
      ? r.content.slice(0, MAX_CHUNK_CHARS)
      : r.content
  );

  try {
    const response = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        query,
        documents,
        top_k: candidates.length,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage API ${response.status}: ${body}`);
    }

    const json = (await response.json()) as VoyageRerankResponse;

    // Build score map: index → relevance_score (0–1)
    const scoreMap = new Map<number, number>();
    for (const item of json.data) {
      scoreMap.set(item.index, item.relevance_score);
    }

    // Blend: 50% original hybrid score (normalized) + 50% Voyage score
    // Voyage is a strong cross-encoder, so we give it equal weight
    const maxOriginal = Math.max(...candidates.map((r) => r.similarity), 0.01);

    const reranked = candidates.map((r, i) => {
      const voyageScore = scoreMap.get(i) ?? 0.5;
      const normalizedOriginal = r.similarity / maxOriginal;
      const blended = normalizedOriginal * 0.5 + voyageScore * 0.5;
      return { ...r, similarity: blended * maxOriginal };
    });

    reranked.sort((a, b) => b.similarity - a.similarity);

    console.log(
      "[voyage-reranker] rerank complete:",
      reranked.slice(0, 5).map((r) => ({
        file: r.source_filename.slice(0, 40),
        score: r.similarity.toFixed(4),
        voyageScore: scoreMap.get(candidates.indexOf(r))?.toFixed(4),
      }))
    );

    // Append any results beyond MAX_CHUNKS_TO_RERANK (keep original order)
    if (results.length > MAX_CHUNKS_TO_RERANK) {
      reranked.push(...results.slice(MAX_CHUNKS_TO_RERANK));
    }

    return reranked;
  } catch (error) {
    console.error("[voyage-reranker] Voyage rerank failed, falling back to original order:", error);
    return results;
  }
}
