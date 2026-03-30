import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { embedQuery } from "@/app/lib/embeddings";

/**
 * POST /api/kb-search — комбинированный поиск по базе знаний.
 *
 * Объединяет три стратегии:
 *   1. Полнотекстовый поиск по filename/folder_path в таблице sources
 *   2. Семантический поиск по эмбеддингам в таблице chunks
 *   3. Группировка результатов по source_id с ранжированием
 *
 * Body: { query: string, limit?: number, folder?: string }
 * Response: { results: KBSearchResult[] }
 */

export interface KBSearchResult {
  source_id: string;
  filename: string;
  folder_path: string | null;
  mime_type: string | null;
  tags: string[];
  content_preview: string | null;
  created_at: string;
  /** Лучший фрагмент из семантического поиска */
  best_chunk: string | null;
  /** Косинусное сходство лучшего фрагмента */
  similarity: number;
  /** Количество совпавших чанков */
  chunk_count: number;
  /** Источник совпадения: fts, semantic, both */
  match_type: "fts" | "semantic" | "both";
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const FTS_BOOST = 0.15; // бонус за совпадение в имени файла

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const limit: number = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const folder: string | null = body.folder ?? null;

    if (!query) {
      return NextResponse.json(
        { error: "Query is required" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // ── 1. Полнотекстовый поиск по sources ──
    const ftsResults = await searchSourcesByText(supabase, query, folder, limit);

    // ── 2. Семантический поиск по chunks ──
    const semanticResults = await searchSourcesBySemantic(
      supabase,
      query,
      folder,
      limit
    );

    // ── 3. Объединение и ранжирование ──
    const merged = mergeResults(ftsResults, semanticResults, limit);

    return NextResponse.json({ results: merged });
  } catch (err) {
    console.error("KB search error:", err);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500 }
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Полнотекстовый поиск по sources (filename, folder_path, content_preview) */
/* ────────────────────────────────────────────────────────────────────────── */

interface FTSRow {
  id: string;
  filename: string;
  folder_path: string | null;
  mime_type: string | null;
  tags: string[];
  content_preview: string | null;
  created_at: string;
}

async function searchSourcesByText(
  supabase: ReturnType<typeof createServiceClient>,
  query: string,
  folder: string | null,
  limit: number
): Promise<Map<string, KBSearchResult>> {
  const results = new Map<string, KBSearchResult>();

  // Разбиваем запрос на слова для ilike-поиска (PostgreSQL FTS по русскому
  // тексту работает нестабильно без словаря, поэтому ilike надёжнее)
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (words.length === 0) return results;

  // Собираем OR-условие: filename ilike '%word%'
  // Supabase JS SDK не поддерживает сложные OR напрямую,
  // поэтому используем RPC или or-фильтр
  let qb = supabase
    .from("sources")
    .select("id, filename, folder_path, mime_type, tags, content_preview, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (folder) {
    qb = qb.eq("folder_path", folder);
  }

  // Фильтрация: ищем по первому слову в filename (основной фильтр)
  // Остальные слова фильтруем на клиенте для точности
  const orConditions = words
    .map((w) => `filename.ilike.%${w}%,content_preview.ilike.%${w}%,folder_path.ilike.%${w}%`)
    .join(",");

  qb = qb.or(orConditions);

  const { data, error } = await qb;

  if (error) {
    console.error("FTS sources error:", error);
    return results;
  }

  for (const row of (data ?? []) as FTSRow[]) {
    const matchScore = calculateFTSScore(row, words);
    if (matchScore > 0) {
      results.set(row.id, {
        source_id: row.id,
        filename: row.filename,
        folder_path: row.folder_path,
        mime_type: row.mime_type,
        tags: row.tags ?? [],
        content_preview: row.content_preview,
        created_at: row.created_at,
        best_chunk: null,
        similarity: matchScore,
        chunk_count: 0,
        match_type: "fts",
      });
    }
  }

  return results;
}

/** Подсчёт релевантности FTS: сколько слов запроса совпало */
function calculateFTSScore(row: FTSRow, words: string[]): number {
  const target = [
    row.filename ?? "",
    row.folder_path ?? "",
    row.content_preview ?? "",
  ]
    .join(" ")
    .toLowerCase();

  let matched = 0;
  for (const w of words) {
    if (target.includes(w)) matched++;
  }

  if (matched === 0) return 0;

  // Нормализуем: все слова совпали = 1.0, + бонус за имя файла
  let score = matched / words.length;
  const filenameLower = (row.filename ?? "").toLowerCase();
  if (words.some((w) => filenameLower.includes(w))) {
    score += FTS_BOOST;
  }

  return Math.min(score, 1.0);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Семантический поиск по chunks → группировка по source_id                  */
/* ────────────────────────────────────────────────────────────────────────── */

interface SemanticRow {
  id: string;
  content: string;
  source_id: string;
  source_filename: string;
  similarity: number;
  tags: string[];
}

async function searchSourcesBySemantic(
  supabase: ReturnType<typeof createServiceClient>,
  query: string,
  folder: string | null,
  limit: number
): Promise<Map<string, KBSearchResult>> {
  const results = new Map<string, KBSearchResult>();

  const queryEmbedding = await embedQuery(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  // Используем существующую RPC-функцию hybrid_search
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: limit * 3, // берём больше, т.к. потом группируем
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: null,
  });

  if (error) {
    console.error("Semantic search error:", error);
    return results;
  }

  // Загружаем метаданные источников для найденных чанков
  const chunkRows = (data ?? []) as SemanticRow[];
  const sourceIds = [...new Set(chunkRows.map((r) => r.source_id))];

  if (sourceIds.length === 0) return results;

  // Получаем sources
  let sourcesQuery = supabase
    .from("sources")
    .select("id, filename, folder_path, mime_type, tags, content_preview, created_at")
    .in("id", sourceIds);

  if (folder) {
    sourcesQuery = sourcesQuery.eq("folder_path", folder);
  }

  const { data: sourcesData } = await sourcesQuery;
  const sourcesMap = new Map<string, FTSRow>();
  for (const s of (sourcesData ?? []) as FTSRow[]) {
    sourcesMap.set(s.id, s);
  }

  // Группируем чанки по source_id
  for (const chunk of chunkRows) {
    const source = sourcesMap.get(chunk.source_id);
    if (!source) continue; // источник отфильтрован по folder

    const existing = results.get(chunk.source_id);
    if (existing) {
      existing.chunk_count++;
      if (chunk.similarity > existing.similarity) {
        existing.similarity = chunk.similarity;
        existing.best_chunk = chunk.content;
      }
    } else {
      results.set(chunk.source_id, {
        source_id: source.id,
        filename: source.filename,
        folder_path: source.folder_path,
        mime_type: source.mime_type,
        tags: source.tags ?? [],
        content_preview: source.content_preview,
        created_at: source.created_at,
        best_chunk: chunk.content,
        similarity: chunk.similarity,
        chunk_count: 1,
        match_type: "semantic",
      });
    }
  }

  return results;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Объединение FTS + Semantic                                                */
/* ────────────────────────────────────────────────────────────────────────── */

function mergeResults(
  ftsMap: Map<string, KBSearchResult>,
  semanticMap: Map<string, KBSearchResult>,
  limit: number
): KBSearchResult[] {
  const merged = new Map<string, KBSearchResult>();

  // Сначала добавляем семантические (основной приоритет)
  for (const [id, result] of semanticMap) {
    merged.set(id, result);
  }

  // Добавляем / обогащаем из FTS
  for (const [id, ftsResult] of ftsMap) {
    const existing = merged.get(id);
    if (existing) {
      // Документ найден обоими способами — повышаем score
      existing.match_type = "both";
      existing.similarity = Math.min(
        existing.similarity + FTS_BOOST,
        1.0
      );
    } else {
      merged.set(id, ftsResult);
    }
  }

  // Сортируем: сначала both > semantic > fts, затем по similarity
  const typeOrder: Record<string, number> = { both: 3, semantic: 2, fts: 1 };
  const sorted = Array.from(merged.values()).sort((a, b) => {
    const typeDiff = (typeOrder[b.match_type] ?? 0) - (typeOrder[a.match_type] ?? 0);
    if (typeDiff !== 0) return typeDiff;
    return b.similarity - a.similarity;
  });

  return sorted.slice(0, limit);
}
