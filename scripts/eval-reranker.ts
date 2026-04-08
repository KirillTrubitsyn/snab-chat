/**
 * Reranker A/B Evaluation Script
 *
 * Evaluates Voyage AI rerank-2.5 on Russian procurement domain queries.
 * Uses Supabase FTS for initial retrieval (since Google Embedding API
 * is not available in this environment).
 *
 * Compares: FTS-only baseline vs Voyage reranked results.
 *
 * Usage: VOYAGE_API_KEY=pa-xxx node --experimental-strip-types scripts/eval-reranker.ts
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── Config ──
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/^\[/, "").split("]")[0];
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY!;
const VOYAGE_MODEL = "rerank-2.5";

// ── Test Queries ──
const TEST_QUERIES = [
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

// ── curl HTTP helper ──

function curlPost(url: string, headers: Record<string, string>, body: unknown, timeoutSec = 60): string {
  const tmpFile = join(tmpdir(), `eval-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(body));
    const headerArgs = Object.entries(headers)
      .map(([k, v]) => `-H '${k}: ${v}'`)
      .join(" ");
    return execSync(
      `curl -s --connect-timeout 15 --max-time ${timeoutSec} -X POST '${url}' ${headerArgs} -H 'Content-Type: application/json' -d @${tmpFile}`,
      { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" }
    );
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function curlGet(url: string, headers: Record<string, string>): string {
  const headerArgs = Object.entries(headers)
    .map(([k, v]) => `-H '${k}: ${v}'`)
    .join(" ");
  return execSync(
    `curl -s --connect-timeout 15 --max-time 30 '${url}' ${headerArgs}`,
    { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" }
  );
}

// ── Types ──
interface Chunk {
  id: string;
  content: string;
  source_filename: string;
  chunk_index: number;
  tags: string[] | null;
}

// ── Supabase FTS search ──

function ftsSearch(query: string, limit = 20): Chunk[] {
  // Use Supabase REST API with textSearch
  const tsQuery = query
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => w.replace(/[^а-яА-ЯёЁa-zA-Z0-9-]/g, ""))
    .filter(Boolean)
    .join(" | ");

  const url = `${SUPABASE_URL}/rest/v1/chunks?select=id,content,source_filename,chunk_index,tags&content=wfts.${encodeURIComponent(tsQuery)}&limit=${limit}`;
  const raw = curlGet(url, {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  });
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      // Fallback: try plain text ILIKE search
      return ilikeSearch(query, limit);
    }
    if (data.length === 0) return ilikeSearch(query, limit);
    return data as Chunk[];
  } catch {
    return ilikeSearch(query, limit);
  }
}

function ilikeSearch(query: string, limit = 20): Chunk[] {
  const keywords = query
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 3);

  if (keywords.length === 0) return [];

  // Use the first long keyword for ILIKE search
  const kw = keywords[0].replace(/[^а-яА-ЯёЁa-zA-Z0-9]/g, "");
  const url = `${SUPABASE_URL}/rest/v1/chunks?select=id,content,source_filename,chunk_index,tags&content=ilike.*${encodeURIComponent(kw)}*&limit=${limit}`;
  const raw = curlGet(url, {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  });
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as Chunk[]) : [];
  } catch {
    return [];
  }
}

// ── Voyage Reranker ──

interface VoyageResult {
  index: number;
  relevance_score: number;
}

function voyageRerank(query: string, chunks: Chunk[]): { scores: VoyageResult[]; latencyMs: number; tokens: number } {
  const start = Date.now();
  // Truncate content aggressively to stay under free-tier TPM limits
  const documents = chunks.map((c) =>
    c.content.length > 1000 ? c.content.slice(0, 1000) : c.content
  );

  const raw = curlPost("https://api.voyageai.com/v1/rerank", {
    Authorization: `Bearer ${VOYAGE_API_KEY}`,
  }, {
    model: VOYAGE_MODEL,
    query,
    documents,
    top_k: chunks.length,
  }, 60);

  const json = JSON.parse(raw) as { data?: VoyageResult[]; usage?: { total_tokens: number }; detail?: string };
  if (!json.data) {
    throw new Error(json.detail || JSON.stringify(json).slice(0, 200));
  }

  return {
    scores: json.data,
    latencyMs: Date.now() - start,
    tokens: json.usage?.total_tokens ?? 0,
  };
}

// ── Main ──

function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  VOYAGE RERANK-2.5 EVALUATION (Russian procurement domain)");
  console.log("═══════════════════════════════════════════════════════════\n");

  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing Supabase env"); process.exit(1); }
  if (!VOYAGE_API_KEY) { console.error("Missing VOYAGE_API_KEY"); process.exit(1); }
  console.log("✓ Supabase + Voyage API available\n");
  console.log("Note: Google API unavailable in this env. Using FTS baseline.\n");

  interface QueryResult {
    query: string;
    chunksFound: number;
    voyageLatency: number;
    voyageTokens: number;
    topReranked: { file: string; score: number; origPos: number }[];
    bottomReranked: { file: string; score: number; origPos: number }[];
    scoreSpread: number; // max - min score (how decisive Voyage is)
    topScore: number;
    avgScore: number;
    reorderAmount: number; // avg position change
  }

  const queryResults: QueryResult[] = [];

  for (let qi = 0; qi < TEST_QUERIES.length; qi++) {
    const query = TEST_QUERIES[qi];
    console.log(`[${qi + 1}/${TEST_QUERIES.length}] "${query}"`);

    try {
      const chunks = ftsSearch(query, 10);
      if (chunks.length < 2) {
        console.log(`  ⚠ Only ${chunks.length} chunk(s) found, skipping\n`);
        continue;
      }
      console.log(`  FTS found: ${chunks.length} chunks from ${new Set(chunks.map((c) => c.source_filename)).size} docs`);

      const voyage = voyageRerank(query, chunks);

      // Build position map: original index → voyage rank
      const origPosMap = new Map(chunks.map((c, i) => [c.id, i]));
      const ranked = voyage.scores
        .map((s) => ({
          chunk: chunks[s.index],
          score: s.relevance_score,
          origPos: s.index,
        }))
        .sort((a, b) => b.score - a.score);

      const scores = ranked.map((r) => r.score);
      const spread = Math.max(...scores) - Math.min(...scores);
      const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;

      // Calculate reorder amount
      let totalDisplacement = 0;
      ranked.forEach((r, newPos) => {
        totalDisplacement += Math.abs(newPos - r.origPos);
      });
      const reorderAmount = totalDisplacement / ranked.length;

      queryResults.push({
        query,
        chunksFound: chunks.length,
        voyageLatency: voyage.latencyMs,
        voyageTokens: voyage.tokens,
        topReranked: ranked.slice(0, 5).map((r) => ({
          file: r.chunk.source_filename,
          score: r.score,
          origPos: r.origPos,
        })),
        bottomReranked: ranked.slice(-3).map((r) => ({
          file: r.chunk.source_filename,
          score: r.score,
          origPos: r.origPos,
        })),
        scoreSpread: spread,
        topScore: scores[0],
        avgScore,
        reorderAmount,
      });

      console.log(`  Voyage: ${voyage.latencyMs}ms, ${voyage.tokens} tokens`);
      console.log(`  Top-3 reranked:`);
      for (const r of ranked.slice(0, 3)) {
        console.log(`    ${r.score.toFixed(4)} | pos ${r.origPos}→0 | ${r.chunk.source_filename.slice(0, 55)}`);
      }
      console.log(`  Score spread: ${spread.toFixed(4)} | avg: ${avgScore.toFixed(4)} | reorder: ${reorderAmount.toFixed(1)} pos\n`);

      // Rate limit: free tier is 3 RPM, wait 21s between requests
      if (qi < TEST_QUERIES.length - 1) {
        process.stdout.write("  (waiting 21s for rate limit...)\r");
        execSync("sleep 21");
      }
    } catch (err) {
      console.error(`  ✗ Error:`, (err as Error).message?.slice(0, 200), "\n");
    }
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                      SUMMARY REPORT                      ");
  console.log("═══════════════════════════════════════════════════════════\n");

  const n = queryResults.length;
  if (n === 0) { console.log("No successful queries."); return; }

  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const avgLatency = avg(queryResults.map((r) => r.voyageLatency));
  const avgTokens = avg(queryResults.map((r) => r.voyageTokens));
  const avgSpread = avg(queryResults.map((r) => r.scoreSpread));
  const avgTopScore = avg(queryResults.map((r) => r.topScore));
  const avgAvgScore = avg(queryResults.map((r) => r.avgScore));
  const avgReorder = avg(queryResults.map((r) => r.reorderAmount));

  console.log(`Queries tested: ${n}/${TEST_QUERIES.length}`);

  console.log(`\n── Performance ──`);
  console.log(`  Avg latency:     ${avgLatency.toFixed(0)}ms`);
  console.log(`  Avg tokens/query: ${avgTokens.toFixed(0)}`);
  const costPer1M = 0.05; // $0.05 per 1M tokens for Voyage rerank
  const costPerQuery = (avgTokens * costPer1M) / 1_000_000;
  console.log(`  Est. cost/query: $${costPerQuery.toFixed(6)} (~$${(costPerQuery * 1000).toFixed(3)} per 1K queries)`);

  console.log(`\n── Relevance Quality ──`);
  console.log(`  Avg top-1 score:    ${avgTopScore.toFixed(4)}`);
  console.log(`  Avg score (all):    ${avgAvgScore.toFixed(4)}`);
  console.log(`  Avg score spread:   ${avgSpread.toFixed(4)} (higher = more decisive ranking)`);
  console.log(`  Avg reorder amount: ${avgReorder.toFixed(1)} positions (from FTS baseline)`);

  // Score distribution analysis
  const highConfidence = queryResults.filter((r) => r.topScore > 0.7);
  const medConfidence = queryResults.filter((r) => r.topScore >= 0.4 && r.topScore <= 0.7);
  const lowConfidence = queryResults.filter((r) => r.topScore < 0.4);

  console.log(`\n── Confidence Distribution ──`);
  console.log(`  High (>0.7):  ${highConfidence.length}/${n} (${((highConfidence.length / n) * 100).toFixed(0)}%)`);
  console.log(`  Medium (0.4-0.7): ${medConfidence.length}/${n} (${((medConfidence.length / n) * 100).toFixed(0)}%)`);
  console.log(`  Low (<0.4):   ${lowConfidence.length}/${n} (${((lowConfidence.length / n) * 100).toFixed(0)}%)`);

  // Show detailed results for each query
  console.log(`\n── Per-Query Details ──`);
  for (const r of queryResults) {
    const top = r.topReranked[0];
    console.log(`\n  Q: "${r.query.slice(0, 60)}"`);
    console.log(`    Top: ${top.score.toFixed(4)} | ${top.file.slice(0, 55)}`);
    console.log(`    Latency: ${r.voyageLatency}ms | Reorder: ${r.reorderAmount.toFixed(1)} | Spread: ${r.scoreSpread.toFixed(4)}`);
  }

  // Assess Russian language handling
  console.log(`\n── Russian Language Assessment ──`);
  const hasGoodSpread = queryResults.filter((r) => r.scoreSpread > 0.3).length;
  const hasStrongTop = queryResults.filter((r) => r.topScore > 0.5).length;
  console.log(`  Queries with good score spread (>0.3): ${hasGoodSpread}/${n}`);
  console.log(`  Queries with strong top match (>0.5):  ${hasStrongTop}/${n}`);
  if (hasGoodSpread / n > 0.6 && hasStrongTop / n > 0.5) {
    console.log(`  → Voyage rerank-2.5 shows GOOD discrimination on Russian procurement queries.`);
  } else if (hasGoodSpread / n > 0.3) {
    console.log(`  → Voyage rerank-2.5 shows MODERATE discrimination on Russian procurement queries.`);
  } else {
    console.log(`  → Voyage rerank-2.5 shows WEAK discrimination — may struggle with domain-specific Russian.`);
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

main();
