import { google, withGoogleApiLimit } from "./google-ai.js";
import { generateObject } from "ai";
import { z } from "zod";
import type { SearchResult } from "./retrieval.js";
import { voyageRerank } from "./voyage-reranker.js";

/**
 * Unified rerank dispatcher.
 * Set RERANKER_MODEL env var to switch:
 *   "voyage"  → Voyage AI rerank-2.5 (cross-encoder, requires VOYAGE_API_KEY)
 *   "gemini"  → Gemini Flash LLM reranker (default, current behavior)
 */
export async function rerank(
  query: string,
  results: SearchResult[]
): Promise<SearchResult[]> {
  const model = (process.env.RERANKER_MODEL ?? "gemini").toLowerCase();

  if (model === "voyage") {
    return voyageRerank(query, results);
  }

  return llmRerank(query, results);
}

const RERANK_MODEL = "gemini-3.1-flash-lite-preview";
const MAX_CHUNKS_TO_RERANK = 20;
const MAX_CHUNK_PREVIEW = 1500; // chars per chunk in reranker prompt

/**
 * LLM-based reranker: sends query + candidate chunks to Gemini Flash
 * and gets back relevance scores (0–10) for each chunk.
 * This acts as a cross-encoder — the model sees query and document together,
 * producing much more accurate relevance judgments than bi-encoder similarity.
 */
export async function llmRerank(
  query: string,
  results: SearchResult[]
): Promise<SearchResult[]> {
  if (results.length <= 1) return results;

  const candidates = results.slice(0, MAX_CHUNKS_TO_RERANK);

  const chunksXml = candidates
    .map((r, i) => {
      const preview =
        r.content.length > MAX_CHUNK_PREVIEW
          ? r.content.slice(0, MAX_CHUNK_PREVIEW) + "…"
          : r.content;
      return `<chunk id="${i}">\n${preview}\n</chunk>`;
    })
    .join("\n");

  try {
    const { object } = await withGoogleApiLimit(() =>
      generateObject({
        model: google(RERANK_MODEL),
        schema: z.object({
          scores: z.array(
            z.object({
              id: z.number().describe("Chunk id (0-based index)"),
              score: z
                .number()
                .min(0)
                .max(10)
                .describe("Relevance score 0-10"),
            })
          ),
        }),
        prompt: `Ты — строгая система оценки релевантности документов для RAG-поиска. Оцени каждый фрагмент по шкале от 0 до 10 — насколько он НАПРЯМУЮ полезен для ответа на вопрос пользователя.

ШКАЛА ОЦЕНКИ (будь строгим — большинство фрагментов должны получить 0-3):
10 = напрямую и полностью отвечает на вопрос, содержит конкретные данные/процедуры/цифры
8-9 = содержит ключевую информацию для ответа (конкретные пункты, таблицы, процедуры по теме)
6-7 = содержит полезный контекст, но не отвечает напрямую (смежная тема, общие положения)
3-5 = тот же домен (закупки), но НЕ по теме вопроса (другая процедура, другой этап, другое юрлицо)
1-2 = упоминает отдельные слова из вопроса, но о другом
0 = совершенно не относится к вопросу

КРИТЕРИИ ОТСЕВА (ставь 0-3):
- Фрагмент из ДРУГОГО режима закупки, чем спрашивает пользователь (223-ФЗ vs вне 223-ФЗ)
- Фрагмент описывает ДРУГУЮ процедуру/этап, чем спрашивают
- Фрагмент о ДРУГОЙ организации, когда вопрос про конкретную
- Фрагмент содержит только оглавление, нумерацию пунктов или служебную разметку
- Фрагмент из учебного курса, когда вопрос о конкретном нормативном пункте

ВОПРОС ПОЛЬЗОВАТЕЛЯ:
${query}

ФРАГМЕНТЫ ДОКУМЕНТОВ:
${chunksXml}

Верни оценку для КАЖДОГО фрагмента. Помни: лучше недооценить сомнительный фрагмент, чем пропустить мусор в контекст модели.`,
        temperature: 0,
      })
    );

    // Build score map
    const scoreMap = new Map<number, number>();
    for (const s of object.scores) {
      if (s.id >= 0 && s.id < candidates.length) {
        scoreMap.set(s.id, s.score);
      }
    }

    // Blend: 50% original hybrid score (normalized) + 50% LLM rerank score (normalized to 0-1)
    // LLM cross-encoder sees query+doc together — give it equal weight for better filtering
    const maxOriginal = Math.max(...candidates.map((r) => r.similarity), 0.01);

    const reranked = candidates.map((r, i) => {
      const llmScore = scoreMap.get(i) ?? 2; // default to low if missing — don't assume relevance
      const normalizedOriginal = r.similarity / maxOriginal;
      const normalizedLlm = llmScore / 10;
      const blended = normalizedOriginal * 0.5 + normalizedLlm * 0.5;
      // Scale back to original score range for compatibility with filterByRelevance thresholds
      return { ...r, similarity: blended * maxOriginal };
    });

    reranked.sort((a, b) => b.similarity - a.similarity);

    console.log(
      "[reranker] LLM rerank complete:",
      reranked.slice(0, 5).map((r) => ({
        file: r.source_filename.slice(0, 40),
        score: r.similarity.toFixed(4),
      }))
    );

    // Append any results beyond MAX_CHUNKS_TO_RERANK (keep original order)
    if (results.length > MAX_CHUNKS_TO_RERANK) {
      reranked.push(...results.slice(MAX_CHUNKS_TO_RERANK));
    }

    return reranked;
  } catch (error) {
    console.error("[reranker] LLM rerank failed, falling back to original order:", error);
    return results;
  }
}
