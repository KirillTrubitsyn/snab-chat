import { google, withGoogleApiLimit } from "./google-ai.js";
import { generateObject } from "ai";
import { z } from "zod";
import type { SearchResult } from "./retrieval.js";
import { voyageRerank } from "./voyage-reranker.js";
import type { IntentResult, QueryIntent } from "./intent-classifier.js";

/* ── Intent-based reranker routing ── */

type RerankerChoice = "gemini" | "voyage";

/**
 * Intent → preferred reranker. Missing intents default to gemini.
 *
 * entity_lookup оставлен на Gemini: короткие запросы ("контрагенты по электромонтажу")
 * требуют доменного понимания, чтобы ранжировать карточки СПУ выше нормативных документов.
 * Voyage чисто семантический и не справляется с такой задачей.
 */
const INTENT_RERANKER_MAP: Partial<Record<QueryIntent, RerankerChoice>> = {
  pricing:       "voyage",   // числовые/табличные данные — больше контекста на чанк (4000 vs 1500)
  general:       "voyage",   // общие вопросы — домен не критичен, экономим Google семафор
};

/**
 * Intents where a clear FZ regime (223 / non-223) overrides Voyage → Gemini,
 * because the Gemini prompt understands regime distinctions.
 */
const REGIME_FORCE_GEMINI: Set<QueryIntent> = new Set([
  "general",
]);

function chooseReranker(intent?: IntentResult): RerankerChoice {
  if (!intent) return "gemini";

  const isStrictRegime = intent.fz_type === "223" || intent.fz_type === "non-223";
  if (isStrictRegime && REGIME_FORCE_GEMINI.has(intent.intent)) {
    return "gemini";
  }

  return INTENT_RERANKER_MAP[intent.intent] ?? "gemini";
}

/**
 * Unified rerank dispatcher.
 *
 * Priority:
 *   1. RERANKER_MODEL env var — absolute override (backward compat)
 *   2. Intent-based routing via chooseReranker()
 */
export async function rerank(
  query: string,
  results: SearchResult[],
  intent?: IntentResult
): Promise<SearchResult[]> {
  const envOverride = (process.env.RERANKER_MODEL ?? "").toLowerCase();

  // ENV var — absolute priority (backward compatibility)
  if (envOverride === "voyage" || envOverride === "gemini") {
    console.log(`[reranker] ${envOverride} (env override)`);
    return envOverride === "voyage" ? voyageRerank(query, results) : llmRerank(query, results);
  }

  // Intent-based routing
  const model = chooseReranker(intent);
  console.log(`[reranker] ${model} (intent=${intent?.intent ?? "none"}, fz=${intent?.fz_type ?? "none"})`);

  return model === "voyage" ? voyageRerank(query, results) : llmRerank(query, results);
}

const RERANK_MODEL = "gemini-3.1-flash-lite-preview";
const MAX_CHUNKS_TO_RERANK = 20;
const MAX_CHUNK_PREVIEW = 1500; // chars per chunk in reranker prompt
const HARD_REJECT_SCORE = 2.5;
const STRONG_KEEP_SCORE = 7.5;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) ?? [])
    .filter((t, i, arr) => arr.indexOf(t) === i);
}

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
        prompt: `Ты — система СТРОГОЙ оценки релевантности документов.
Оцени каждый фрагмент по шкале от 0 до 10 — насколько он полезен для ответа на вопрос пользователя.
Если фрагмент только тематически похож, но НЕ помогает ответить на конкретный вопрос — ставь 0-3.
Если фрагмент относится к другому объекту/организации/режиму закупок — ставь 0-2.

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

Верни оценку для КАЖДОГО фрагмента. Будь максимально строгим: мусор и общие совпадения должны получать низкий балл.`,
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

    // Blend with strong LLM priority:
    // original retrieval is recall-heavy and can contain semantic noise.
    // LLM cross-encoder score should dominate the final rank.
    const maxOriginal = Math.max(...candidates.map((r) => r.similarity), 0.01);
    const queryTokens = new Set(tokenize(query));

    const reranked = candidates.map((r, i) => {
      const llmScore = scoreMap.get(i) ?? 2; // default to low if missing — don't assume relevance
      const normalizedOriginal = r.similarity / maxOriginal;
      const normalizedLlm = llmScore / 10;
      const blended = normalizedOriginal * 0.35 + normalizedLlm * 0.65;

      const chunkTokens = tokenize(r.content);
      const overlap = chunkTokens.length === 0
        ? 0
        : chunkTokens.filter((t) => queryTokens.has(t)).length / chunkTokens.length;

      let finalScore = blended;
      // Hard suppress obvious garbage: low LLM score + almost no lexical overlap.
      if (llmScore < HARD_REJECT_SCORE && overlap < 0.08) {
        finalScore *= 0.25;
      }
      // Small bonus for highly relevant chunks to increase separation from the tail.
      if (llmScore >= STRONG_KEEP_SCORE) {
        finalScore *= 1.05;
      }
      // Scale back to original score range for compatibility with filterByRelevance thresholds
      return { ...r, similarity: finalScore * maxOriginal };
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
