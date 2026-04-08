/**
 * benchmark-rerankers.ts
 *
 * Comprehensive comparative benchmark for reranking models on the СГК/СнабЧат
 * Russian procurement knowledge base. Compares five strategies:
 *   • no-rerank          — baseline: original hybrid-search order
 *   • gemini-llm         — LLM cross-encoder via Gemini Flash Lite (scores 0-10)
 *   • voyage-rerank-2.5  — Voyage AI cross-encoder (relevance_score 0-1)
 *   • cohere-rerank-v3.5 — Cohere multilingual cross-encoder (relevance_score 0-1)
 *   • jina-reranker-v2   — Jina multilingual cross-encoder (relevance_score 0-1)
 *
 * Each model is enabled automatically when its API key is present.
 * LLM-as-Judge (Gemini) provides nDCG@5 as the gold-standard quality metric.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=ey... \
 *   GOOGLE_API_KEY=...  [VOYAGE_API_KEY=...] [COHERE_API_KEY=...] [JINA_API_KEY=...] \
 *   node --experimental-strip-types scripts/benchmark-rerankers.ts
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ─── Configuration ────────────────────────────────────────────────────────────

const SUPABASE_URL   = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? "";
const COHERE_API_KEY = process.env.COHERE_API_KEY ?? "";
const JINA_API_KEY   = process.env.JINA_API_KEY   ?? "";

const GEMINI_RERANK_MODEL = "gemini-3.1-flash-lite-preview"; // matches app/lib/reranker.ts
const GEMINI_JUDGE_MODEL  = "gemini-2.5-flash";              // stronger model for judging

const FTS_CANDIDATES = 20; // candidates to fetch per query
const TOP_K          = 5;  // top-K for overlap and nDCG metrics

// Estimated cost per API call (20 chunks × ~500 tokens avg = ~10 K tokens)
const COST_USD_PER_CALL: Record<string, number> = {
  "no-rerank":          0,
  "gemini-llm":         0.00075, // ~10 K tokens × $0.075 / 1M (Flash Lite input)
  "voyage-rerank-2.5":  0.00050, // ~10 K tokens × $0.05  / 1M
  "cohere-rerank-v3.5": 0.00200, // $2 / 1 K searches
  "jina-reranker-v2":   0.00018, // ~10 K tokens × $0.018 / 1M
};

// Minimum inter-call interval in ms (free-tier limits)
const MIN_INTERVAL_MS: Record<string, number> = {
  "gemini-llm":         4_000,  // 15 RPM free tier
  "gemini-judge":       4_000,
  "voyage-rerank-2.5":  21_000, // 3 RPM free tier
  "cohere-rerank-v3.5": 600,    // 100 RPM
  "jina-reranker-v2":   1_000,  // 60 RPM
};

// ─── Test queries ─────────────────────────────────────────────────────────────

const TEST_QUERIES: string[] = [
  "Кто согласовывает закупки свыше 50 млн рублей?",
  "Порядок проведения закупки у единственного источника",
  "Какие документы нужны для заключения договора?",
  "Как определить начальную максимальную цену контракта?",
  "Критерии оценки заявок участников закупки",
  "Порядок обжалования результатов закупки",
  "Что такое закупочная комиссия и её полномочия?",
  "Лимиты и пороги для децентрализованных закупок",
  "Как оформить дополнительное соглашение к договору?",
  "Требования к участникам закупки по 223-ФЗ",
  "Какой порядок согласования ТЗ на закупку?",
  "Перечень документов при приёмке товаров",
  "Как рассчитать НМЦ методом сопоставимых рыночных цен?",
  "Сроки размещения извещения о закупке",
  "Какие способы закупок предусмотрены положением?",
  "Порядок работы с реестром единственных поставщиков",
  "Как провести конкурентные переговоры?",
  "Матрица полномочий дирекции по закупкам",
  "Ответственность за нарушение порядка закупок",
  "Как подготовить обоснование закупки у единственного источника?",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Chunk {
  id: string;
  content: string;
  source_filename: string;
  chunk_index: number;
  similarity: number;
  tags: string[] | null;
}

interface RerankerResult {
  model: string;
  rankedIds: string[];   // chunk IDs in descending relevance order
  rawScores: number[];   // raw scores parallel to rankedIds
  latencyMs: number;
  estimatedCostUsd: number;
  error?: string;
}

interface JudgeRating {
  chunkId: string;
  rating: number; // 0–3: 3=ideal, 2=useful, 1=partial, 0=irrelevant
}

interface QueryMetrics {
  latencyMs: number;
  costUsd: number;
  scoreSpread: number;        // max − min raw score (discriminativeness)
  avgReorderAmount: number;   // avg position displacement vs. no-rerank baseline
  ndcg5: number;              // −1 when judge not available
}

interface QueryResult {
  query: string;
  candidateCount: number;
  models: Record<string, RerankerResult>;
  judgeRatings: JudgeRating[];
  metrics: Record<string, QueryMetrics>;
}

// ─── curl helpers ─────────────────────────────────────────────────────────────

function curlPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutSec = 90
): string {
  const tmp = join(tmpdir(), `bench-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(body));
    const hdrs = Object.entries(headers)
      .map(([k, v]) => `-H '${k}: ${v}'`)
      .join(" ");
    return execSync(
      `curl -s --connect-timeout 20 --max-time ${timeoutSec} ` +
      `-X POST '${url}' ${hdrs} -H 'Content-Type: application/json' -d @${tmp}`,
      { maxBuffer: 20 * 1024 * 1024, encoding: "utf-8" }
    );
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function curlGet(url: string, headers: Record<string, string>): string {
  const hdrs = Object.entries(headers)
    .map(([k, v]) => `-H '${k}: ${v}'`)
    .join(" ");
  return execSync(
    `curl -s --connect-timeout 15 --max-time 30 '${url}' ${hdrs}`,
    { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" }
  );
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const lastCallAt: Record<string, number> = {};

function rateLimit(modelKey: string): void {
  const minMs = MIN_INTERVAL_MS[modelKey] ?? 1_000;
  const elapsed = Date.now() - (lastCallAt[modelKey] ?? 0);
  if (elapsed < minMs) {
    const wait = minMs - elapsed + 100;
    process.stdout.write(
      `  [rate-limit] ${modelKey}: waiting ${(wait / 1000).toFixed(1)}s…\r`
    );
    execSync(`sleep ${(wait / 1000).toFixed(2)}`);
    process.stdout.write(" ".repeat(60) + "\r");
  }
  lastCallAt[modelKey] = Date.now();
}

// ─── Retrieval: Supabase FTS with ILIKE fallback ──────────────────────────────

function ftsSearch(query: string, limit = FTS_CANDIDATES): Chunk[] {
  const tsQuery = query
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => w.replace(/[^а-яА-ЯёЁa-zA-Z0-9-]/g, ""))
    .filter(Boolean)
    .join(" | ");

  if (tsQuery) {
    const url =
      `${SUPABASE_URL}/rest/v1/chunks` +
      `?select=id,content,source_filename,chunk_index,tags` +
      `&content=wfts.${encodeURIComponent(tsQuery)}&limit=${limit}`;
    try {
      const raw = curlGet(url, {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      });
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        return data.map((c: Chunk, i: number) => ({
          ...c,
          tags: c.tags ?? [],
          similarity: 1 - i * 0.04, // synthetic descending score for baseline
        }));
      }
    } catch { /* fall through */ }
  }
  return ilikeSearch(query, limit);
}

function ilikeSearch(query: string, limit = FTS_CANDIDATES): Chunk[] {
  const kw = query
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 2)
    .map((w) => w.replace(/[^а-яА-ЯёЁa-zA-Z0-9]/g, ""))
    .filter(Boolean);

  if (!kw.length) return [];

  const url =
    `${SUPABASE_URL}/rest/v1/chunks` +
    `?select=id,content,source_filename,chunk_index,tags` +
    `&content=ilike.*${encodeURIComponent(kw[0])}*&limit=${limit}`;
  try {
    const raw = curlGet(url, {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    });
    const data = JSON.parse(raw);
    return Array.isArray(data)
      ? data.map((c: Chunk, i: number) => ({
          ...c,
          tags: c.tags ?? [],
          similarity: 1 - i * 0.04,
        }))
      : [];
  } catch {
    return [];
  }
}

// ─── Reranker adapters ────────────────────────────────────────────────────────

function runNoRerank(chunks: Chunk[]): RerankerResult {
  return {
    model: "no-rerank",
    rankedIds:         chunks.map((c) => c.id),
    rawScores:         chunks.map((_, i) => 1 - i * 0.04),
    latencyMs:         0,
    estimatedCostUsd:  0,
  };
}

function runGeminiLlmRerank(query: string, chunks: Chunk[]): RerankerResult {
  const model = "gemini-llm";
  if (!GOOGLE_API_KEY) {
    return { model, rankedIds: [], rawScores: [], latencyMs: 0, estimatedCostUsd: 0, error: "No GOOGLE_API_KEY" };
  }

  rateLimit(model);
  const start = Date.now();

  const MAX_CHARS = 1_200;
  const candidates = chunks.slice(0, 20);
  const chunksXml = candidates
    .map((c, i) => {
      const preview = c.content.length > MAX_CHARS
        ? c.content.slice(0, MAX_CHARS) + "…"
        : c.content;
      return `<chunk id="${i}">\n${preview}\n</chunk>`;
    })
    .join("\n");

  const prompt =
    `Оцени каждый фрагмент документа по шкале 0-10: насколько он полезен ` +
    `для ответа на вопрос пользователя.\n` +
    `10=напрямую отвечает, 7-9=важная информация, 4-6=частично релевантен, ` +
    `1-3=слабо связан, 0=не относится.\n\n` +
    `ВОПРОС: ${query}\n\nФРАГМЕНТЫ:\n${chunksXml}\n\n` +
    `Верни ТОЛЬКО JSON в формате: {"scores":[{"id":0,"score":8},{"id":1,"score":3},...]}`;

  try {
    const raw = curlPost(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_RERANK_MODEL}:generateContent?key=${GOOGLE_API_KEY}`,
      {},
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }
    );
    const resp = JSON.parse(raw);
    const text: string = resp?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text) as { scores?: { id: number; score: number }[] };

    const scoreMap = new Map<number, number>();
    for (const s of parsed.scores ?? []) scoreMap.set(s.id, s.score);

    const scored = candidates
      .map((c, i) => ({ id: c.id, score: scoreMap.get(i) ?? 5 }))
      .sort((a, b) => b.score - a.score);

    return {
      model,
      rankedIds:        scored.map((s) => s.id),
      rawScores:        scored.map((s) => s.score),
      latencyMs:        Date.now() - start,
      estimatedCostUsd: COST_USD_PER_CALL[model],
    };
  } catch (err) {
    return {
      model,
      rankedIds:        chunks.map((c) => c.id),
      rawScores:        [],
      latencyMs:        Date.now() - start,
      estimatedCostUsd: 0,
      error:            String(err).slice(0, 200),
    };
  }
}

function runVoyageRerank(query: string, chunks: Chunk[]): RerankerResult {
  const model = "voyage-rerank-2.5";
  if (!VOYAGE_API_KEY) {
    return { model, rankedIds: [], rawScores: [], latencyMs: 0, estimatedCostUsd: 0, error: "No VOYAGE_API_KEY" };
  }

  rateLimit(model);
  const start = Date.now();
  const candidates = chunks.slice(0, 20);
  const documents = candidates.map((c) =>
    c.content.length > 2_000 ? c.content.slice(0, 2_000) : c.content
  );

  try {
    const raw = curlPost(
      "https://api.voyageai.com/v1/rerank",
      { Authorization: `Bearer ${VOYAGE_API_KEY}` },
      { model: "rerank-2.5", query, documents, top_k: documents.length }
    );
    const resp = JSON.parse(raw) as {
      data?: { index: number; relevance_score: number }[];
      detail?: string;
    };
    if (!resp.data) throw new Error(resp.detail ?? JSON.stringify(resp).slice(0, 200));

    const sorted = [...resp.data].sort((a, b) => b.relevance_score - a.relevance_score);
    return {
      model,
      rankedIds:        sorted.map((s) => candidates[s.index].id),
      rawScores:        sorted.map((s) => s.relevance_score),
      latencyMs:        Date.now() - start,
      estimatedCostUsd: COST_USD_PER_CALL[model],
    };
  } catch (err) {
    return {
      model,
      rankedIds:        chunks.map((c) => c.id),
      rawScores:        [],
      latencyMs:        Date.now() - start,
      estimatedCostUsd: 0,
      error:            String(err).slice(0, 200),
    };
  }
}

function runCohereRerank(query: string, chunks: Chunk[]): RerankerResult {
  const model = "cohere-rerank-v3.5";
  if (!COHERE_API_KEY) {
    return { model, rankedIds: [], rawScores: [], latencyMs: 0, estimatedCostUsd: 0, error: "No COHERE_API_KEY" };
  }

  rateLimit(model);
  const start = Date.now();
  const candidates = chunks.slice(0, 20);
  // rerank-multilingual-v3.0 supports Russian and 100+ other languages
  const documents = candidates.map((c) =>
    c.content.length > 4_000 ? c.content.slice(0, 4_000) : c.content
  );

  try {
    const raw = curlPost(
      "https://api.cohere.com/v2/rerank",
      { Authorization: `Bearer ${COHERE_API_KEY}` },
      {
        model:            "rerank-multilingual-v3.0",
        query,
        documents,
        top_n:            documents.length,
        return_documents: false,
      }
    );
    const resp = JSON.parse(raw) as {
      results?: { index: number; relevance_score: number }[];
      message?: string;
    };
    if (!resp.results) throw new Error(resp.message ?? JSON.stringify(resp).slice(0, 200));

    const sorted = [...resp.results].sort((a, b) => b.relevance_score - a.relevance_score);
    return {
      model,
      rankedIds:        sorted.map((s) => candidates[s.index].id),
      rawScores:        sorted.map((s) => s.relevance_score),
      latencyMs:        Date.now() - start,
      estimatedCostUsd: COST_USD_PER_CALL[model],
    };
  } catch (err) {
    return {
      model,
      rankedIds:        chunks.map((c) => c.id),
      rawScores:        [],
      latencyMs:        Date.now() - start,
      estimatedCostUsd: 0,
      error:            String(err).slice(0, 200),
    };
  }
}

function runJinaRerank(query: string, chunks: Chunk[]): RerankerResult {
  const model = "jina-reranker-v2";
  if (!JINA_API_KEY) {
    return { model, rankedIds: [], rawScores: [], latencyMs: 0, estimatedCostUsd: 0, error: "No JINA_API_KEY" };
  }

  rateLimit(model);
  const start = Date.now();
  const candidates = chunks.slice(0, 20);
  const documents = candidates.map((c) =>
    c.content.length > 2_000 ? c.content.slice(0, 2_000) : c.content
  );

  try {
    const raw = curlPost(
      "https://api.jina.ai/v1/rerank",
      { Authorization: `Bearer ${JINA_API_KEY}` },
      {
        model:     "jina-reranker-v2-base-multilingual",
        query,
        documents,
        top_n:     documents.length,
      }
    );
    const resp = JSON.parse(raw) as {
      results?: { index: number; relevance_score: number }[];
      detail?: string;
    };
    if (!resp.results) throw new Error(resp.detail ?? JSON.stringify(resp).slice(0, 200));

    const sorted = [...resp.results].sort((a, b) => b.relevance_score - a.relevance_score);
    return {
      model,
      rankedIds:        sorted.map((s) => candidates[s.index].id),
      rawScores:        sorted.map((s) => s.relevance_score),
      latencyMs:        Date.now() - start,
      estimatedCostUsd: COST_USD_PER_CALL[model],
    };
  } catch (err) {
    return {
      model,
      rankedIds:        chunks.map((c) => c.id),
      rawScores:        [],
      latencyMs:        Date.now() - start,
      estimatedCostUsd: 0,
      error:            String(err).slice(0, 200),
    };
  }
}

// ─── LLM-as-Judge ─────────────────────────────────────────────────────────────

/**
 * Asks Gemini to rate each chunk 0–3 for relevance to the query.
 * Rates all unique chunks from all rerankers' top-K in a single call.
 */
function getJudgeRatings(
  query: string,
  chunkIds: string[],
  chunkMap: Map<string, Chunk>
): JudgeRating[] {
  if (!GOOGLE_API_KEY || chunkIds.length === 0) return [];

  rateLimit("gemini-judge");

  const MAX_CHARS = 800;
  const chunksXml = chunkIds
    .map((id, i) => {
      const c = chunkMap.get(id);
      if (!c) return `<chunk id="${i}">…</chunk>`;
      const preview = c.content.length > MAX_CHARS
        ? c.content.slice(0, MAX_CHARS) + "…"
        : c.content;
      return `<chunk id="${i}">\n${preview}\n</chunk>`;
    })
    .join("\n");

  const prompt =
    `Ты — эксперт по закупочной деятельности. Оцени релевантность каждого ` +
    `фрагмента для ответа на вопрос по шкале 0-3:\n` +
    `3=идеально отвечает на вопрос\n2=содержит полезную информацию по теме\n` +
    `1=частично связан с темой\n0=не относится к вопросу\n\n` +
    `ВОПРОС: ${query}\n\nФРАГМЕНТЫ:\n${chunksXml}\n\n` +
    `Верни ТОЛЬКО JSON: {"ratings":[{"id":0,"rating":3},{"id":1,"rating":1},...]}`;

  try {
    const raw = curlPost(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_JUDGE_MODEL}:generateContent?key=${GOOGLE_API_KEY}`,
      {},
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }
    );
    const resp = JSON.parse(raw);
    const text: string = resp?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text) as { ratings?: { id: number; rating: number }[] };

    return (parsed.ratings ?? [])
      .map((r) => ({
        chunkId: chunkIds[r.id] ?? "",
        rating:  Math.max(0, Math.min(3, Math.round(r.rating))),
      }))
      .filter((r) => r.chunkId);
  } catch {
    return [];
  }
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

/** Normalised Discounted Cumulative Gain at k using graded relevance 0–3. */
function computeNDCG(
  orderedIds: string[],
  ratingMap: Map<string, number>,
  k = 5
): number {
  const topK = orderedIds.slice(0, k);
  const dcg = topK.reduce((sum, id, i) => {
    const rel = ratingMap.get(id) ?? 0;
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);

  // Ideal DCG: best possible ordering of all known ratings
  const idealRatings = [...ratingMap.values()].sort((a, b) => b - a);
  const idcg = idealRatings.slice(0, k).reduce((sum, rel, i) => {
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);

  return idcg > 0 ? dcg / idcg : 0;
}

/** Spearman rank correlation for common chunk IDs between two orderings. */
function computeSpearman(ids1: string[], ids2: string[]): number {
  const common = ids1.filter((id) => ids2.includes(id));
  const n = common.length;
  if (n < 2) return 0;

  const rank1 = new Map(ids1.map((id, i) => [id, i + 1]));
  const rank2 = new Map(ids2.map((id, i) => [id, i + 1]));

  const dSqSum = common.reduce((sum, id) => {
    const d = (rank1.get(id) ?? n) - (rank2.get(id) ?? n);
    return sum + d * d;
  }, 0);

  return 1 - (6 * dSqSum) / (n * (n * n - 1));
}

/** Fraction of top-K IDs shared between two orderings. */
function computeTopKOverlap(ids1: string[], ids2: string[], k: number): number {
  const set1 = new Set(ids1.slice(0, k));
  const set2 = new Set(ids2.slice(0, k));
  let hits = 0;
  for (const id of set1) if (set2.has(id)) hits++;
  return k > 0 ? hits / k : 0;
}

/** Max − min score (how decisive the ranker's discrimination is). */
function computeScoreSpread(scores: number[]): number {
  if (scores.length < 2) return 0;
  return Math.max(...scores) - Math.min(...scores);
}

/** Average absolute position displacement vs. baseline order. */
function computeAvgReorder(baselineIds: string[], rerankedIds: string[]): number {
  if (rerankedIds.length < 2) return 0;
  const origRank = new Map(baselineIds.map((id, i) => [id, i]));
  const total = rerankedIds.reduce((sum, id, newPos) => {
    return sum + Math.abs(newPos - (origRank.get(id) ?? newPos));
  }, 0);
  return total / rerankedIds.length;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const avg = (arr: number[]): number =>
  arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

function padR(s: string, n: number): string { return s.slice(0, n).padEnd(n); }
function padL(s: string, n: number): string { return s.slice(0, n).padStart(n); }
function fmt(n: number, d = 3): string      { return n.toFixed(d); }

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("═".repeat(72));
  console.log("  RERANKER BENCHMARK  —  Russian Procurement Domain (СГК/СнабЧат)");
  console.log("═".repeat(72) + "\n");

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }

  // Determine active models
  const activeModels: string[] = ["no-rerank"];
  const log = (ok: boolean, msg: string) => console.log((ok ? "✓" : "○") + " " + msg);

  log(!!GOOGLE_API_KEY, GOOGLE_API_KEY
    ? "Gemini LLM reranker enabled"
    : "Gemini disabled (no GOOGLE_API_KEY)");
  if (GOOGLE_API_KEY) activeModels.push("gemini-llm");

  log(!!VOYAGE_API_KEY, VOYAGE_API_KEY
    ? "Voyage rerank-2.5 enabled  [rate-limit: 3 RPM]"
    : "Voyage disabled (no VOYAGE_API_KEY)");
  if (VOYAGE_API_KEY) activeModels.push("voyage-rerank-2.5");

  log(!!COHERE_API_KEY, COHERE_API_KEY
    ? "Cohere rerank-v3.5 enabled (multilingual)"
    : "Cohere disabled (no COHERE_API_KEY)");
  if (COHERE_API_KEY) activeModels.push("cohere-rerank-v3.5");

  log(!!JINA_API_KEY, JINA_API_KEY
    ? "Jina reranker-v2 enabled (multilingual)"
    : "Jina disabled (no JINA_API_KEY)");
  if (JINA_API_KEY) activeModels.push("jina-reranker-v2");

  const judgeEnabled = !!GOOGLE_API_KEY;
  log(judgeEnabled, judgeEnabled
    ? "LLM-as-Judge enabled (Gemini → nDCG@5)"
    : "LLM-as-Judge disabled (no GOOGLE_API_KEY)");

  console.log(`\nActive models : ${activeModels.join("  |  ")}`);
  console.log(`Queries       : ${TEST_QUERIES.length}`);
  console.log(`Candidates    : ${FTS_CANDIDATES} per query (Supabase FTS)\n`);

  // ── Query loop ──────────────────────────────────────────────────────────────

  const allQueryResults: QueryResult[] = [];

  for (let qi = 0; qi < TEST_QUERIES.length; qi++) {
    const query = TEST_QUERIES[qi];
    console.log(`\n[${qi + 1}/${TEST_QUERIES.length}] ${query}`);
    console.log("─".repeat(70));

    const chunks = ftsSearch(query);
    console.log(`  Retrieval: ${chunks.length} chunks`);

    if (chunks.length < 2) {
      console.log("  ⚠ Too few candidates — skipping");
      continue;
    }

    const chunkMap = new Map(chunks.map((c) => [c.id, c]));
    const modelResults: Record<string, RerankerResult> = {};

    // Run every active model
    for (const modelName of activeModels) {
      let result: RerankerResult;
      switch (modelName) {
        case "no-rerank":          result = runNoRerank(chunks);                  break;
        case "gemini-llm":         result = runGeminiLlmRerank(query, chunks);    break;
        case "voyage-rerank-2.5":  result = runVoyageRerank(query, chunks);       break;
        case "cohere-rerank-v3.5": result = runCohereRerank(query, chunks);       break;
        case "jina-reranker-v2":   result = runJinaRerank(query, chunks);         break;
        default: continue;
      }
      modelResults[modelName] = result;

      if (result.error) {
        console.log(`  ${padR(modelName, 22)}: ✗ ${result.error}`);
      } else {
        const top3 = result.rankedIds.slice(0, 3).map((id, i) => {
          const c = chunkMap.get(id);
          const score = result.rawScores[i] !== undefined
            ? result.rawScores[i].toFixed(3)
            : "?";
          return `[${score}] ${c?.source_filename?.slice(0, 28) ?? id}`;
        }).join("  ");
        console.log(`  ${padR(modelName, 22)}: ${result.latencyMs}ms  ${top3}`);
      }
    }

    // LLM-as-Judge: unique top-K chunks from all rerankers
    let judgeRatings: JudgeRating[] = [];
    if (judgeEnabled) {
      const judgeSet = new Set<string>();
      for (const r of Object.values(modelResults)) {
        if (!r.error) r.rankedIds.slice(0, TOP_K).forEach((id) => judgeSet.add(id));
      }
      judgeRatings = getJudgeRatings(query, [...judgeSet], chunkMap);

      if (judgeRatings.length > 0) {
        const top3 = [...judgeRatings]
          .sort((a, b) => b.rating - a.rating)
          .slice(0, 3)
          .map((r) => `[${r.rating}] ${chunkMap.get(r.chunkId)?.source_filename?.slice(0, 28) ?? r.chunkId}`)
          .join("  ");
        console.log(`  ${"judge".padEnd(22)}: ${top3}`);
      }
    }

    // Compute per-query metrics
    const ratingMap = new Map(judgeRatings.map((r) => [r.chunkId, r.rating]));
    const baselineIds = modelResults["no-rerank"]?.rankedIds ?? chunks.map((c) => c.id);
    const queryMetrics: Record<string, QueryMetrics> = {};

    for (const [modelName, result] of Object.entries(modelResults)) {
      if (result.error) continue;
      queryMetrics[modelName] = {
        latencyMs:        result.latencyMs,
        costUsd:          result.estimatedCostUsd,
        scoreSpread:      computeScoreSpread(result.rawScores),
        avgReorderAmount: modelName === "no-rerank" ? 0 : computeAvgReorder(baselineIds, result.rankedIds),
        ndcg5:            judgeEnabled && ratingMap.size > 0
          ? computeNDCG(result.rankedIds, ratingMap, 5)
          : -1,
      };
    }

    allQueryResults.push({
      query,
      candidateCount: chunks.length,
      models:         modelResults,
      judgeRatings,
      metrics:        queryMetrics,
    });
  }

  // ── Aggregate statistics ────────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(72));
  console.log("  BENCHMARK RESULTS");
  console.log("═".repeat(72) + "\n");

  type ModelAgg = {
    queries: number;
    latencies: number[];
    costs: number[];
    spreads: number[];
    reorders: number[];
    ndcgs: number[];
  };
  const agg: Record<string, ModelAgg> = {};

  for (const qr of allQueryResults) {
    for (const [m, metrics] of Object.entries(qr.metrics)) {
      if (!agg[m]) agg[m] = { queries: 0, latencies: [], costs: [], spreads: [], reorders: [], ndcgs: [] };
      agg[m].queries++;
      agg[m].latencies.push(metrics.latencyMs);
      agg[m].costs.push(metrics.costUsd);
      agg[m].spreads.push(metrics.scoreSpread);
      agg[m].reorders.push(metrics.avgReorderAmount);
      if (metrics.ndcg5 >= 0) agg[m].ndcgs.push(metrics.ndcg5);
    }
  }

  const MODEL_ORDER = [
    "no-rerank",
    "gemini-llm",
    "voyage-rerank-2.5",
    "cohere-rerank-v3.5",
    "jina-reranker-v2",
  ];
  const presentModels = MODEL_ORDER.filter((m) => agg[m]);

  // ── Aggregate table ────────────────────────────────────────────────────────

  console.log("── Aggregate metrics per model ──\n");
  const H1 = `${padR("Model", 22)} ${padL("n", 4)} ${padL("Lat ms", 7)} ${padL("$/query", 9)} ${padL("Spread", 8)} ${padL("Reorder", 8)} ${padL("nDCG@5", 8)}`;
  console.log(H1);
  console.log("─".repeat(H1.length));

  for (const m of presentModels) {
    const s = agg[m];
    const ndcgStr = s.ndcgs.length ? fmt(avg(s.ndcgs)) : "  n/a  ";
    console.log(
      `${padR(m, 22)} ` +
      `${padL(String(s.queries), 4)} ` +
      `${padL(fmt(avg(s.latencies), 0) + "ms", 7)} ` +
      `${padL("$" + fmt(avg(s.costs), 5), 9)} ` +
      `${padL(fmt(avg(s.spreads)), 8)} ` +
      `${padL(fmt(avg(s.reorders), 2), 8)} ` +
      `${padL(ndcgStr, 8)}`
    );
  }

  // ── Pairwise overlap matrix ────────────────────────────────────────────────

  if (presentModels.length > 1 && allQueryResults.length > 0) {
    console.log(`\n── Top-${TOP_K} overlap matrix (avg fraction of shared top-${TOP_K}) ──\n`);
    const colW = 11;
    process.stdout.write(" ".repeat(22));
    for (const m of presentModels) process.stdout.write(` ${padL(m.slice(0, colW - 1), colW)}`);
    console.log();

    for (const m1 of presentModels) {
      process.stdout.write(padR(m1, 22));
      for (const m2 of presentModels) {
        if (m1 === m2) { process.stdout.write(` ${"1.000".padStart(colW)}`); continue; }
        const values = allQueryResults
          .map((qr) => {
            const r1 = qr.models[m1];
            const r2 = qr.models[m2];
            if (!r1 || !r2 || r1.error || r2.error) return null;
            return computeTopKOverlap(r1.rankedIds, r2.rankedIds, TOP_K);
          })
          .filter((v): v is number => v !== null);
        process.stdout.write(` ${padL(values.length ? fmt(avg(values)) : "n/a", colW)}`);
      }
      console.log();
    }

    // ── Spearman correlation matrix ──────────────────────────────────────────

    console.log("\n── Spearman rank correlation matrix (avg over all queries) ──\n");
    process.stdout.write(" ".repeat(22));
    for (const m of presentModels) process.stdout.write(` ${padL(m.slice(0, colW - 1), colW)}`);
    console.log();

    for (const m1 of presentModels) {
      process.stdout.write(padR(m1, 22));
      for (const m2 of presentModels) {
        if (m1 === m2) { process.stdout.write(` ${"1.000".padStart(colW)}`); continue; }
        const values = allQueryResults
          .map((qr) => {
            const r1 = qr.models[m1];
            const r2 = qr.models[m2];
            if (!r1 || !r2 || r1.error || r2.error) return null;
            return computeSpearman(r1.rankedIds, r2.rankedIds);
          })
          .filter((v): v is number => v !== null);
        process.stdout.write(` ${padL(values.length ? fmt(avg(values)) : "n/a", colW)}`);
      }
      console.log();
    }
  }

  // ── Per-query nDCG@5 table ─────────────────────────────────────────────────

  if (judgeEnabled) {
    console.log("\n── Per-query nDCG@5 ──\n");
    const colW2 = 9;
    const qH = `${padR("Query", 56)} ` +
      presentModels.map((m) => padL(m.slice(0, colW2), colW2)).join(" ");
    console.log(qH);
    console.log("─".repeat(qH.length));

    for (const qr of allQueryResults) {
      const scores = presentModels
        .map((m) => {
          const v = qr.metrics[m]?.ndcg5;
          return padL(v !== undefined && v >= 0 ? fmt(v) : "n/a", colW2);
        })
        .join(" ");
      console.log(`${padR(qr.query.slice(0, 55), 56)} ${scores}`);
    }
  }

  // ── Recommendation ────────────────────────────────────────────────────────

  console.log("\n── Recommendation ──\n");

  if (judgeEnabled && allQueryResults.length > 0) {
    const ranked = presentModels
      .filter((m) => agg[m] && agg[m].ndcgs.length > 0)
      .map((m) => ({
        model:   m,
        ndcg:    avg(agg[m].ndcgs),
        latency: avg(agg[m].latencies),
        cost:    avg(agg[m].costs),
      }))
      .sort((a, b) => b.ndcg - a.ndcg);

    if (ranked.length > 0) {
      console.log(`Ranking by nDCG@5:\n`);
      for (const r of ranked) {
        const bar = "█".repeat(Math.round(r.ndcg * 20));
        console.log(
          `  ${padR(r.model, 22)}  nDCG@5=${fmt(r.ndcg)}  ` +
          `lat=${fmt(r.latency, 0)}ms  cost=$${fmt(r.cost, 5)}/q  ${bar}`
        );
      }

      const best = ranked[0];
      console.log(`\n→ Best quality       : ${best.model} (nDCG@5 = ${fmt(best.ndcg)})`);

      const paidModels = ranked.filter((r) => r.cost > 0);
      if (paidModels.length > 0) {
        const bestRatio = [...paidModels]
          .sort((a, b) => (b.ndcg / b.cost) - (a.ndcg / a.cost))[0];
        console.log(`→ Best quality/cost  : ${bestRatio.model} (nDCG=${fmt(bestRatio.ndcg)}, $${fmt(bestRatio.cost, 5)}/q)`);
      }

      const fastest = [...ranked].sort((a, b) => a.latency - b.latency)[0];
      console.log(`→ Fastest            : ${fastest.model} (${fmt(fastest.latency, 0)}ms)`);
    }
  } else {
    console.log("(LLM-as-Judge unavailable — quality ranking not possible)");
    console.log("Metrics available: spread, reorder amount, latency\n");
    for (const m of presentModels) {
      const s = agg[m];
      if (!s) continue;
      console.log(
        `  ${padR(m, 22)} spread=${fmt(avg(s.spreads))}  ` +
        `reorder=${fmt(avg(s.reorders), 2)} pos  lat=${fmt(avg(s.latencies), 0)}ms`
      );
    }
  }

  // ── Save JSON ──────────────────────────────────────────────────────────────

  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const outPath = join(process.cwd(), `benchmark-results-${ts}.json`);

  const output = {
    meta: {
      timestamp:    new Date().toISOString(),
      modelsActive: activeModels,
      judgeEnabled,
      queryCount:   allQueryResults.length,
      topK:         TOP_K,
    },
    aggregates: Object.fromEntries(
      presentModels.map((m) => {
        const s = agg[m];
        return [m, {
          queriesRun:       s.queries,
          avgLatencyMs:     avg(s.latencies),
          avgCostUsd:       avg(s.costs),
          avgScoreSpread:   avg(s.spreads),
          avgReorderAmount: avg(s.reorders),
          avgNdcg5:         s.ndcgs.length ? avg(s.ndcgs) : null,
        }];
      })
    ),
    pairwiseOverlapK5: Object.fromEntries(
      presentModels.map((m1) => [
        m1,
        Object.fromEntries(
          presentModels.map((m2) => {
            if (m1 === m2) return [m2, 1];
            const vals = allQueryResults
              .map((qr) => {
                const r1 = qr.models[m1]; const r2 = qr.models[m2];
                if (!r1 || !r2 || r1.error || r2.error) return null;
                return computeTopKOverlap(r1.rankedIds, r2.rankedIds, TOP_K);
              })
              .filter((v): v is number => v !== null);
            return [m2, vals.length ? avg(vals) : null];
          })
        ),
      ])
    ),
    pairwiseSpearman: Object.fromEntries(
      presentModels.map((m1) => [
        m1,
        Object.fromEntries(
          presentModels.map((m2) => {
            if (m1 === m2) return [m2, 1];
            const vals = allQueryResults
              .map((qr) => {
                const r1 = qr.models[m1]; const r2 = qr.models[m2];
                if (!r1 || !r2 || r1.error || r2.error) return null;
                return computeSpearman(r1.rankedIds, r2.rankedIds);
              })
              .filter((v): v is number => v !== null);
            return [m2, vals.length ? avg(vals) : null];
          })
        ),
      ])
    ),
    queryResults: allQueryResults,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ Full results saved → ${outPath}\n`);
}

main();
