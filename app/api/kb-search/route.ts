import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { embedQuery } from "@/app/lib/embeddings";

/**
 * POST /api/kb-search — комбинированный поиск по базе знаний.
 *
 * v2: Parent-Child чанкинг + ссылки на оригинальные файлы.
 *
 * Объединяет три стратегии:
 *   1. Полнотекстовый поиск по filename/folder_path в таблице sources
 *   2. Семантический поиск по эмбеддингам в таблице chunks
 *   3. Группировка результатов по source_id с ранжированием
 *
 * Новое в v2:
 *   - sibling_chunks: все чанки с тем же parent_group_key (Parent-Child)
 *   - original_filename / original_file_url: ссылки на исходный документ
 *   - Параметр include_siblings: включить/выключить подгрузку siblings
 *
 * Body: { query: string, limit?: number, folder?: string, include_siblings?: boolean }
 * Response: { results: KBSearchResult[] }
 */

export interface SiblingChunk {
  content: string;
  chunk_index: number;
}

export interface KBSearchResult {
  /** bigint в Supabase, передаётся как number */
  source_id: number | string;
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
  /** Ключ группы (Parent-Child) */
  parent_group_key: string | null;
  /** Все чанки из той же parent-группы, отсортированные по chunk_index */
  sibling_chunks: SiblingChunk[];
  /** Имя оригинального файла (до денормализации) */
  original_filename: string | null;
  /** URL для скачивания оригинального файла */
  original_file_url: string | null;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const FTS_BOOST = 0.15;
const MAX_SIBLINGS = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const limit: number = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const folder: string | null = body.folder ?? null;
    const includeSiblings: boolean = body.include_siblings ?? true;

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

    // ── 4. Подгрузка sibling-чанков (Parent-Child) ──
    if (includeSiblings) {
      await enrichWithSiblings(supabase, merged);
    }

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
  original_filename: string | null;
  original_file_url: string | null;
}

async function searchSourcesByText(
  supabase: ReturnType<typeof createServiceClient>,
  query: string,
  folder: string | null,
  limit: number
): Promise<Map<string, KBSearchResult>> {
  const results = new Map<string, KBSearchResult>();

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (words.length === 0) return results;

  let qb = supabase
    .from("sources")
    .select("id, filename, folder_path, mime_type, tags, content_preview, created_at, original_filename, original_file_url")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (folder) {
    qb = qb.eq("folder_path", folder);
  }

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
        parent_group_key: null,
        sibling_chunks: [],
        original_filename: row.original_filename,
        original_file_url: row.original_file_url,
      });
    }
  }

  return results;
}

/** Подсчёт релевантности FTS */
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
  parent_group_key: string | null;
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

  // Используем расширенную RPC с parent_group_key
  const { data, error } = await supabase.rpc("hybrid_search_with_parent", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: limit * 3,
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: null,
  });

  if (error) {
    // Fallback: если hybrid_search_with_parent ещё не создана,
    // используем старую hybrid_search
    console.warn("hybrid_search_with_parent failed, falling back:", error.message);
    return searchSourcesBySemanticLegacy(supabase, query, embeddingStr, folder, limit);
  }

  const chunkRows = (data ?? []) as SemanticRow[];
  const sourceIds = [...new Set(chunkRows.map((r) => r.source_id))];

  if (sourceIds.length === 0) return results;

  let sourcesQuery = supabase
    .from("sources")
    .select("id, filename, folder_path, mime_type, tags, content_preview, created_at, original_filename, original_file_url")
    .in("id", sourceIds);

  if (folder) {
    sourcesQuery = sourcesQuery.eq("folder_path", folder);
  }

  const { data: sourcesData } = await sourcesQuery;
  const sourcesMap = new Map<string, FTSRow>();
  for (const s of (sourcesData ?? []) as FTSRow[]) {
    sourcesMap.set(s.id, s);
  }

  // Группируем чанки по source_id, запоминаем parent_group_key лучшего чанка
  for (const chunk of chunkRows) {
    const source = sourcesMap.get(chunk.source_id);
    if (!source) continue;

    const existing = results.get(chunk.source_id);
    if (existing) {
      existing.chunk_count++;
      if (chunk.similarity > existing.similarity) {
        existing.similarity = chunk.similarity;
        existing.best_chunk = chunk.content;
        existing.parent_group_key = chunk.parent_group_key;
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
        parent_group_key: chunk.parent_group_key,
        sibling_chunks: [],
        original_filename: source.original_filename,
        original_file_url: source.original_file_url,
      });
    }
  }

  return results;
}

/** Fallback для старой RPC без parent_group_key */
async function searchSourcesBySemanticLegacy(
  supabase: ReturnType<typeof createServiceClient>,
  query: string,
  embeddingStr: string,
  folder: string | null,
  limit: number
): Promise<Map<string, KBSearchResult>> {
  const results = new Map<string, KBSearchResult>();

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: limit * 3,
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: null,
  });

  if (error) {
    console.error("Semantic search error:", error);
    return results;
  }

  const chunkRows = (data ?? []) as Array<{
    id: string; content: string; source_id: string;
    source_filename: string; similarity: number; tags: string[];
  }>;
  const sourceIds = [...new Set(chunkRows.map((r) => r.source_id))];
  if (sourceIds.length === 0) return results;

  let sourcesQuery = supabase
    .from("sources")
    .select("id, filename, folder_path, mime_type, tags, content_preview, created_at, original_filename, original_file_url")
    .in("id", sourceIds);
  if (folder) sourcesQuery = sourcesQuery.eq("folder_path", folder);

  const { data: sourcesData } = await sourcesQuery;
  const sourcesMap = new Map<string, FTSRow>();
  for (const s of (sourcesData ?? []) as FTSRow[]) sourcesMap.set(s.id, s);

  for (const chunk of chunkRows) {
    const source = sourcesMap.get(chunk.source_id);
    if (!source) continue;
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
        parent_group_key: null,
        sibling_chunks: [],
        original_filename: source.original_filename,
        original_file_url: source.original_file_url,
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

  for (const [id, result] of semanticMap) {
    merged.set(id, result);
  }

  for (const [id, ftsResult] of ftsMap) {
    const existing = merged.get(id);
    if (existing) {
      existing.match_type = "both";
      existing.similarity = Math.min(
        existing.similarity + FTS_BOOST,
        1.0
      );
      // Подхватываем original_filename/url из FTS, если semantic не вернул
      if (!existing.original_filename && ftsResult.original_filename) {
        existing.original_filename = ftsResult.original_filename;
      }
      if (!existing.original_file_url && ftsResult.original_file_url) {
        existing.original_file_url = ftsResult.original_file_url;
      }
    } else {
      merged.set(id, ftsResult);
    }
  }

  const typeOrder: Record<string, number> = { both: 3, semantic: 2, fts: 1 };
  const sorted = Array.from(merged.values()).sort((a, b) => {
    const typeDiff = (typeOrder[b.match_type] ?? 0) - (typeOrder[a.match_type] ?? 0);
    if (typeDiff !== 0) return typeDiff;
    return b.similarity - a.similarity;
  });

  return sorted.slice(0, limit);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Подгрузка sibling-чанков (Parent-Child)                                   */
/* ────────────────────────────────────────────────────────────────────────── */

async function enrichWithSiblings(
  supabase: ReturnType<typeof createServiceClient>,
  results: KBSearchResult[]
): Promise<void> {
  // Собираем уникальные parent_group_key из результатов
  const keysToFetch = new Set<string>();
  for (const r of results) {
    if (r.parent_group_key) {
      keysToFetch.add(r.parent_group_key);
    }
  }

  if (keysToFetch.size === 0) return;

  // Загружаем sibling-чанки для каждого уникального ключа
  // (параллельно, но ограничиваем до top-5 результатов для экономии)
  const topKeys = Array.from(keysToFetch).slice(0, 5);

  const siblingPromises = topKeys.map(async (key) => {
    const { data, error } = await supabase.rpc("get_sibling_chunks", {
      p_parent_group_key: key,
      p_max_siblings: MAX_SIBLINGS,
    });

    if (error) {
      console.warn(`Siblings fetch failed for ${key}:`, error.message);
      return { key, siblings: [] as SiblingChunk[] };
    }

    const siblings: SiblingChunk[] = (data ?? []).map((row: { content: string; chunk_index: number }) => ({
      content: row.content,
      chunk_index: row.chunk_index,
    }));

    return { key, siblings };
  });

  const siblingResults = await Promise.all(siblingPromises);
  const siblingsMap = new Map<string, SiblingChunk[]>();
  for (const { key, siblings } of siblingResults) {
    siblingsMap.set(key, siblings);
  }

  // Проставляем siblings в результаты
  for (const r of results) {
    if (r.parent_group_key && siblingsMap.has(r.parent_group_key)) {
      r.sibling_chunks = siblingsMap.get(r.parent_group_key) ?? [];
    }
  }
}
