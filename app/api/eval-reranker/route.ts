import { NextRequest, NextResponse } from "next/server";
import { hybridSearch } from "@/app/lib/retrieval";
import { llmRerank } from "@/app/lib/reranker";
import { voyageRerank } from "@/app/lib/voyage-reranker";
import { google, withGoogleApiLimit } from "@/app/lib/google-ai";
import { generateObject } from "ai";
import { z } from "zod";
import type { SearchResult } from "@/app/lib/retrieval";

export const runtime = "nodejs";
export const maxDuration = 120;

// ─── Test queries (same set as scripts/benchmark-rerankers.ts) ────────────────

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

// ─── Cost estimates per call ──────────────────────────────────────────────────

const COST_PER_CALL: Record<string, number> = {
  "no-rerank":          0,
  "gemini-llm":         0.00075,
  "voyage-rerank-2.5":  0.00050,
  "cohere-rerank-v3.5": 0.00200,
  "jina-reranker-v2":   0.00018,
};

// ─── Reranker adapters (fetch-based for Next.js runtime) ──────────────────────

async function cohereRerank(
  query: string,
  results: SearchResult[]
): Promise<SearchResult[]> {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) return results;

  const candidates = results.slice(0, 20);
  const documents = candidates.map((r) =>
    r.content.length > 4_000 ? r.content.slice(0, 4_000) : r.content
  );

  const resp = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:            "rerank-multilingual-v3.0",
      query,
      documents,
      top_n:            documents.length,
      return_documents: false,
    }),
  });

  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Cohere API ${resp.status}: ${msg.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    results: { index: number; relevance_score: number }[];
  };

  const scoreMap = new Map<number, number>();
  for (const item of json.results) scoreMap.set(item.index, item.relevance_score);

  const maxOrig = Math.max(...candidates.map((r) => r.similarity), 0.01);
  const reranked = candidates.map((r, i) => {
    const cohereScore = scoreMap.get(i) ?? 0.5;
    const normOrig = r.similarity / maxOrig;
    return { ...r, similarity: (normOrig * 0.5 + cohereScore * 0.5) * maxOrig };
  });

  reranked.sort((a, b) => b.similarity - a.similarity);
  if (results.length > 20) reranked.push(...results.slice(20));
  return reranked;
}

async function jinaRerank(
  query: string,
  results: SearchResult[]
): Promise<SearchResult[]> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) return results;

  const candidates = results.slice(0, 20);
  const documents = candidates.map((r) =>
    r.content.length > 2_000 ? r.content.slice(0, 2_000) : r.content
  );

  const resp = await fetch("https://api.jina.ai/v1/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:     "jina-reranker-v2-base-multilingual",
      query,
      documents,
      top_n:     documents.length,
    }),
  });

  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Jina API ${resp.status}: ${msg.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    results: { index: number; relevance_score: number }[];
  };

  const scoreMap = new Map<number, number>();
  for (const item of json.results) scoreMap.set(item.index, item.relevance_score);

  const maxOrig = Math.max(...candidates.map((r) => r.similarity), 0.01);
  const reranked = candidates.map((r, i) => {
    const jinaScore = scoreMap.get(i) ?? 0.5;
    const normOrig = r.similarity / maxOrig;
    return { ...r, similarity: (normOrig * 0.5 + jinaScore * 0.5) * maxOrig };
  });

  reranked.sort((a, b) => b.similarity - a.similarity);
  if (results.length > 20) reranked.push(...results.slice(20));
  return reranked;
}

// ─── LLM-as-Judge ─────────────────────────────────────────────────────────────

async function judgeTopK(
  query: string,
  chunkIds: string[],
  chunkMap: Map<string, SearchResult>
): Promise<Map<string, number>> {
  if (!process.env.GOOGLE_API_KEY || chunkIds.length === 0) return new Map();

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

  const { object } = await withGoogleApiLimit(() =>
    generateObject({
      model: google("gemini-2.0-flash"),
      schema: z.object({
        ratings: z.array(
          z.object({
            id:     z.number().describe("Chunk index (0-based)"),
            rating: z.number().min(0).max(3).describe("Relevance rating 0-3"),
          })
        ),
      }),
      prompt:
        `Ты — эксперт по закупочной деятельности. Оцени каждый фрагмент ` +
        `по шкале 0-3 (3=идеально отвечает, 2=полезная информация, ` +
        `1=частично связан, 0=нерелевантен).\n\n` +
        `ВОПРОС: ${query}\n\nФРАГМЕНТЫ:\n${chunksXml}`,
      temperature: 0,
    })
  );

  const ratingMap = new Map<string, number>();
  for (const r of object.ratings) {
    const id = chunkIds[r.id];
    if (id) ratingMap.set(id, Math.max(0, Math.min(3, Math.round(r.rating))));
  }
  return ratingMap;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function computeNDCG(orderedIds: string[], ratingMap: Map<string, number>, k = 5): number {
  const topK = orderedIds.slice(0, k);
  const dcg = topK.reduce((sum, id, i) => {
    const rel = ratingMap.get(id) ?? 0;
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);
  const idealRatings = [...ratingMap.values()].sort((a, b) => b - a);
  const idcg = idealRatings.slice(0, k).reduce((sum, rel, i) => {
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);
  return idcg > 0 ? dcg / idcg : 0;
}

function computeTopKOverlap(ids1: string[], ids2: string[], k: number): number {
  const s1 = new Set(ids1.slice(0, k));
  const s2 = new Set(ids2.slice(0, k));
  let hits = 0;
  for (const id of s1) if (s2.has(id)) hits++;
  return k > 0 ? hits / k : 0;
}

function computeSpearman(ids1: string[], ids2: string[]): number {
  const common = ids1.filter((id) => ids2.includes(id));
  const n = common.length;
  if (n < 2) return 0;
  const r1 = new Map(ids1.map((id, i) => [id, i + 1]));
  const r2 = new Map(ids2.map((id, i) => [id, i + 1]));
  const dSq = common.reduce((s, id) => {
    const d = (r1.get(id) ?? n) - (r2.get(id) ?? n);
    return s + d * d;
  }, 0);
  return 1 - (6 * dSq) / (n * (n * n - 1));
}

function computeScoreSpread(results: SearchResult[]): number {
  if (results.length < 2) return 0;
  const sims = results.map((r) => r.similarity);
  return Math.max(...sims) - Math.min(...sims);
}

function computeAvgReorder(orig: SearchResult[], reranked: SearchResult[]): number {
  const origRank = new Map(orig.map((r, i) => [r.id, i]));
  const total = reranked.reduce((sum, r, newPos) => {
    return sum + Math.abs(newPos - (origRank.get(r.id) ?? newPos));
  }, 0);
  return reranked.length > 0 ? total / reranked.length : 0;
}

const avg = (arr: number[]) =>
  arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

// ─── GET handler ──────────────────────────────────────────────────────────────

/**
 * GET /api/eval-reranker
 *
 * Query params:
 *   n       - number of test queries to run (default: 5, max: 20)
 *   judge   - "true" to enable LLM-as-Judge nDCG@5 (default: false, adds latency)
 *   models  - comma-separated list to restrict models, e.g. "no-rerank,gemini-llm"
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const params  = req.nextUrl.searchParams;
  const nRaw    = parseInt(params.get("n") ?? "5", 10);
  const nQ      = Math.max(1, Math.min(20, isNaN(nRaw) ? 5 : nRaw));
  const judge   = params.get("judge") === "true";
  const onlyStr = params.get("models");
  const only    = onlyStr ? onlyStr.split(",").map((s) => s.trim()) : null;

  // Determine available models
  const available: string[] = ["no-rerank"];
  if (process.env.GOOGLE_API_KEY)  available.push("gemini-llm");
  if (process.env.VOYAGE_API_KEY)  available.push("voyage-rerank-2.5");
  if (process.env.COHERE_API_KEY)  available.push("cohere-rerank-v3.5");
  if (process.env.JINA_API_KEY)    available.push("jina-reranker-v2");

  const activeModels = only
    ? available.filter((m) => only.includes(m))
    : available;

  const queries = TEST_QUERIES.slice(0, nQ);
  const results: unknown[] = [];

  for (const query of queries) {
    const queryStart = Date.now();

    // Retrieval: hybrid search (vector + FTS)
    let candidates: SearchResult[];
    try {
      candidates = await hybridSearch(query, 20);
    } catch (err) {
      results.push({ query, error: `retrieval failed: ${String(err).slice(0, 200)}` });
      continue;
    }

    if (candidates.length < 2) {
      results.push({ query, error: `only ${candidates.length} candidates` });
      continue;
    }

    const chunkMap = new Map(candidates.map((r) => [r.id, r]));
    const modelResults: Record<string, {
      rankedIds: string[];
      rawScores: number[];
      latencyMs: number;
      costUsd: number;
      error?: string;
    }> = {};

    // Run each active model
    for (const modelName of activeModels) {
      const mStart = Date.now();
      try {
        let reranked: SearchResult[];

        switch (modelName) {
          case "no-rerank":
            reranked = candidates;
            break;
          case "gemini-llm":
            reranked = await llmRerank(query, candidates);
            break;
          case "voyage-rerank-2.5":
            reranked = await voyageRerank(query, candidates);
            break;
          case "cohere-rerank-v3.5":
            reranked = await cohereRerank(query, candidates);
            break;
          case "jina-reranker-v2":
            reranked = await jinaRerank(query, candidates);
            break;
          default:
            continue;
        }

        modelResults[modelName] = {
          rankedIds: reranked.map((r) => r.id),
          rawScores: reranked.map((r) => r.similarity),
          latencyMs: Date.now() - mStart,
          costUsd:   COST_PER_CALL[modelName] ?? 0,
        };
      } catch (err) {
        modelResults[modelName] = {
          rankedIds: candidates.map((r) => r.id),
          rawScores: [],
          latencyMs: Date.now() - mStart,
          costUsd:   0,
          error:     String(err).slice(0, 200),
        };
      }
    }

    // LLM-as-Judge
    let ratingMap = new Map<string, number>();
    const judgeRatings: { chunkId: string; rating: number }[] = [];
    if (judge) {
      const judgeIds = new Set<string>();
      for (const r of Object.values(modelResults)) {
        if (!r.error) r.rankedIds.slice(0, 5).forEach((id) => judgeIds.add(id));
      }
      try {
        ratingMap = await judgeTopK(query, [...judgeIds], chunkMap);
        for (const [chunkId, rating] of ratingMap) judgeRatings.push({ chunkId, rating });
      } catch { /* judge failure is non-fatal */ }
    }

    // Metrics
    const baselineIds = modelResults["no-rerank"]?.rankedIds ?? candidates.map((r) => r.id);
    const metrics: Record<string, {
      latencyMs: number;
      costUsd: number;
      scoreSpread: number;
      avgReorderAmount: number;
      ndcg5: number | null;
      top5: { id: string; score: number; filename: string }[];
    }> = {};

    for (const [modelName, mr] of Object.entries(modelResults)) {
      if (mr.error) continue;
      const top5 = mr.rankedIds.slice(0, 5).map((id, i) => ({
        id,
        score:    mr.rawScores[i] ?? 0,
        filename: chunkMap.get(id)?.source_filename ?? "",
      }));
      const ndcg5 = judge && ratingMap.size > 0
        ? computeNDCG(mr.rankedIds, ratingMap, 5)
        : null;

      metrics[modelName] = {
        latencyMs:        mr.latencyMs,
        costUsd:          mr.costUsd,
        scoreSpread:      computeScoreSpread(
          mr.rankedIds.map((id) => chunkMap.get(id) ?? candidates[0])
        ),
        avgReorderAmount: modelName === "no-rerank"
          ? 0
          : computeAvgReorder(
              baselineIds.map((id) => chunkMap.get(id)!).filter(Boolean),
              mr.rankedIds.map((id) => chunkMap.get(id)!).filter(Boolean)
            ),
        ndcg5,
        top5,
      };
    }

    // Pairwise overlap & Spearman for this query
    const pairwise: Record<string, Record<string, {
      overlapK5: number | null;
      spearman: number | null;
    }>> = {};
    const modelNames = Object.keys(modelResults).filter((m) => !modelResults[m].error);
    for (const m1 of modelNames) {
      pairwise[m1] = {};
      for (const m2 of modelNames) {
        if (m1 === m2) continue;
        pairwise[m1][m2] = {
          overlapK5: computeTopKOverlap(modelResults[m1].rankedIds, modelResults[m2].rankedIds, 5),
          spearman:  computeSpearman(modelResults[m1].rankedIds, modelResults[m2].rankedIds),
        };
      }
    }

    results.push({
      query,
      candidateCount: candidates.length,
      totalMs:        Date.now() - queryStart,
      metrics,
      judgeRatings,
      pairwise,
    });
  }

  // Aggregate
  type AggEntry = {
    latencies: number[];
    costs: number[];
    spreads: number[];
    reorders: number[];
    ndcgs: number[];
  };
  const agg: Record<string, AggEntry> = {};

  for (const qr of results as Array<{
    metrics?: Record<string, { latencyMs: number; costUsd: number; scoreSpread: number; avgReorderAmount: number; ndcg5: number | null }>;
  }>) {
    if (!qr.metrics) continue;
    for (const [m, mets] of Object.entries(qr.metrics)) {
      if (!agg[m]) agg[m] = { latencies: [], costs: [], spreads: [], reorders: [], ndcgs: [] };
      agg[m].latencies.push(mets.latencyMs);
      agg[m].costs.push(mets.costUsd);
      agg[m].spreads.push(mets.scoreSpread);
      agg[m].reorders.push(mets.avgReorderAmount);
      if (mets.ndcg5 !== null) agg[m].ndcgs.push(mets.ndcg5);
    }
  }

  const aggregates = Object.fromEntries(
    Object.entries(agg).map(([m, s]) => [m, {
      avgLatencyMs:     avg(s.latencies),
      avgCostUsd:       avg(s.costs),
      avgScoreSpread:   avg(s.spreads),
      avgReorderAmount: avg(s.reorders),
      avgNdcg5:         s.ndcgs.length ? avg(s.ndcgs) : null,
    }])
  );

  // Simple recommendation
  let recommendation: string | null = null;
  if (judge) {
    const ranked = Object.entries(aggregates)
      .filter(([, a]) => (a as { avgNdcg5: number | null }).avgNdcg5 !== null)
      .sort(([, a], [, b]) => ((b as { avgNdcg5: number }).avgNdcg5) - ((a as { avgNdcg5: number }).avgNdcg5));
    if (ranked.length > 0) {
      const [bestModel, bestAgg] = ranked[0];
      recommendation = `Best quality: ${bestModel} (nDCG@5 = ${(bestAgg as { avgNdcg5: number }).avgNdcg5.toFixed(3)})`;
    }
  }

  return NextResponse.json({
    meta: {
      timestamp:    new Date().toISOString(),
      queriesRun:   results.length,
      modelsActive: activeModels,
      judgeEnabled: judge,
    },
    aggregates,
    recommendation,
    queryResults: results,
  });
}
