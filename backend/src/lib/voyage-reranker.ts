import type { SearchResult } from "./retrieval.js";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/rerank";
const VOYAGE_MODEL = "rerank-2.5";
const MAX_CHUNKS_TO_RERANK = 20;
const MAX_CHUNK_CHARS = 4000; // Voyage rerank-2.5 handles up to ~16K tokens per doc; 4K chars is safe

// Score thresholds aligned with Gemini LLM reranker to keep filterByRelevance compatible
const HARD_REJECT_SCORE = 0.15;  // Voyage 0–1 scale; below this = near-zero relevance
const STRONG_KEEP_SCORE = 0.65;  // Above this = highly relevant chunk

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

    // Blend: 40% original hybrid score + 60% Voyage cross-encoder score.
    // Voyage is a purpose-built cross-encoder — give it dominant weight.
    // Apply hard reject / boost to match the score distribution that
    // filterByRelevance expects (calibrated for Gemini LLM reranker).
    const maxOriginal = Math.max(...candidates.map((r) => r.similarity), 0.01);

    const reranked = candidates.map((r, i) => {
      const voyageScore = scoreMap.get(i) ?? 0.1; // default low if missing
      const normalizedOriginal = r.similarity / maxOriginal;
      const blended = normalizedOriginal * 0.4 + voyageScore * 0.6;

      let finalScore = blended;
      // Hard suppress garbage: low Voyage score means the cross-encoder
      // confidently judged this chunk as irrelevant.
      if (voyageScore < HARD_REJECT_SCORE) {
        finalScore *= 0.25;
      }
      // Boost highly relevant chunks to increase separation from the tail.
      if (voyageScore >= STRONG_KEEP_SCORE) {
        finalScore *= 1.05;
      }

      // Scale back to original score range for filterByRelevance compatibility
      return { ...r, similarity: finalScore * maxOriginal };
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
