import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { embedQuery } from "@/app/lib/embeddings";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

/**
 * POST /api/kb-search â ÐºÐ¾Ð¼Ð±Ð¸Ð½Ð¸ÑÐ¾Ð²Ð°Ð½Ð½ÑÐ¹ Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾ Ð±Ð°Ð·Ðµ Ð·Ð½Ð°Ð½Ð¸Ð¹.
 *
 * ÐÐ±ÑÐµÐ´Ð¸Ð½ÑÐµÑ ÑÑÐ¸ ÑÑÑÐ°ÑÐµÐ³Ð¸Ð¸:
 *   1. ÐÐ¾Ð»Ð½Ð¾ÑÐµÐºÑÑÐ¾Ð²ÑÐ¹ Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾ filename/folder_path Ð² ÑÐ°Ð±Ð»Ð¸ÑÐµ sources
 *   2. Ð¡ÐµÐ¼Ð°Ð½ÑÐ¸ÑÐµÑÐºÐ¸Ð¹ Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾ ÑÐ¼Ð±ÐµÐ´Ð´Ð¸Ð½Ð³Ð°Ð¼ Ð² ÑÐ°Ð±Ð»Ð¸ÑÐµ chunks
 *   3. ÐÑÑÐ¿Ð¿Ð¸ÑÐ¾Ð²ÐºÐ° ÑÐµÐ·ÑÐ»ÑÑÐ°ÑÐ¾Ð² Ð¿Ð¾ source_id Ñ ÑÐ°Ð½Ð¶Ð¸ÑÐ¾Ð²Ð°Ð½Ð¸ÐµÐ¼
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
  /** ÐÑÑÑÐ¸Ð¹ ÑÑÐ°Ð³Ð¼ÐµÐ½Ñ Ð¸Ð· ÑÐµÐ¼Ð°Ð½ÑÐ¸ÑÐµÑÐºÐ¾Ð³Ð¾ Ð¿Ð¾Ð¸ÑÐºÐ° */
  best_chunk: string | null;
  /** ÐÐ¾ÑÐ¸Ð½ÑÑÐ½Ð¾Ðµ ÑÑÐ¾Ð´ÑÑÐ²Ð¾ Ð»ÑÑÑÐµÐ³Ð¾ ÑÑÐ°Ð³Ð¼ÐµÐ½ÑÐ° */
  similarity: number;
  /** ÐÐ¾Ð»Ð¸ÑÐµÑÑÐ²Ð¾ ÑÐ¾Ð²Ð¿Ð°Ð²ÑÐ¸Ñ ÑÐ°Ð½ÐºÐ¾Ð² */
  chunk_count: number;
  /** ÐÑÑÐ¾ÑÐ½Ð¸Ðº ÑÐ¾Ð²Ð¿Ð°Ð´ÐµÐ½Ð¸Ñ: fts, semantic, both */
  match_type: "fts" | "semantic" | "both";
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const FTS_BOOST = 0.15; // Ð±Ð¾Ð½ÑÑ Ð·Ð° ÑÐ¾Ð²Ð¿Ð°Ð´ÐµÐ½Ð¸Ðµ Ð² Ð¸Ð¼ÐµÐ½Ð¸ ÑÐ°Ð¹Ð»Ð°

export async function POST(req: NextRequest) {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return unauthorizedResponse();

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

    // ââ 1. ÐÐ¾Ð»Ð½Ð¾ÑÐµÐºÑÑÐ¾Ð²ÑÐ¹ Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾ sources ââ
    const ftsResults = await searchSourcesByText(supabase, query, folder, limit);

    // ââ 2. Ð¡ÐµÐ¼Ð°Ð½ÑÐ¸ÑÐµÑÐºÐ¸Ð¹ Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾ chunks ââ
    const semanticResults = await searchSourcesBySemantic(
      supabase,
      query,
      folder,
      limit
    );

    // ââ 3. ÐÐ±ÑÐµÐ´Ð¸Ð½ÐµÐ½Ð¸Ðµ Ð¸ ÑÐ°Ð½Ð¶Ð¸ÑÐ¾Ð²Ð°Ð½Ð¸Ðµ ââ
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

/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */
/* ÐÐ¾Ð»Ð½Ð¾ÑÐµÐºÑÑÐ¾Ð²ÑÐ¹ Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾ sources (filename, folder_path, content_preview) */
/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

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

  // Ð Ð°Ð·Ð±Ð¸Ð²Ð°ÐµÐ¼ Ð·Ð°Ð¿ÑÐ¾Ñ Ð½Ð° ÑÐ»Ð¾Ð²Ð° Ð´Ð»Ñ ilike-Ð¿Ð¾Ð¸ÑÐºÐ° (PostgreSQL FTS Ð¿Ð¾ ÑÑÑÑÐºÐ¾Ð¼Ñ
  // ÑÐµÐºÑÑÑ ÑÐ°Ð±Ð¾ÑÐ°ÐµÑ Ð½ÐµÑÑÐ°Ð±Ð¸Ð»ÑÐ½Ð¾ Ð±ÐµÐ· ÑÐ»Ð¾Ð²Ð°ÑÑ, Ð¿Ð¾ÑÑÐ¾Ð¼Ñ ilike Ð½Ð°Ð´ÑÐ¶Ð½ÐµÐµ)
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (words.length === 0) return results;

  // Ð¡Ð¾Ð±Ð¸ÑÐ°ÐµÐ¼ OR-ÑÑÐ»Ð¾Ð²Ð¸Ðµ: filename ilike '%word%'
  // Supabase JS SDK Ð½Ðµ Ð¿Ð¾Ð´Ð´ÐµÑÐ¶Ð¸Ð²Ð°ÐµÑ ÑÐ»Ð¾Ð¶Ð½ÑÐµ OR Ð½Ð°Ð¿ÑÑÐ¼ÑÑ,
  // Ð¿Ð¾ÑÑÐ¾Ð¼Ñ Ð¸ÑÐ¿Ð¾Ð»ÑÐ·ÑÐµÐ¼ RPC Ð¸Ð»Ð¸ or-ÑÐ¸Ð»ÑÑÑ
  let qb = supabase
    .from("sources")
    .select("id, filename, folder_path, mime_type, tags, content_preview, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (folder) {
    qb = qb.eq("folder_path", folder);
  }

  // Ð¤Ð¸Ð»ÑÑÑÐ°ÑÐ¸Ñ: Ð¸ÑÐµÐ¼ Ð¿Ð¾ Ð¿ÐµÑÐ²Ð¾Ð¼Ñ ÑÐ»Ð¾Ð²Ñ Ð² filename (Ð¾ÑÐ½Ð¾Ð²Ð½Ð¾Ð¹ ÑÐ¸Ð»ÑÑÑ)
  // ÐÑÑÐ°Ð»ÑÐ½ÑÐµ ÑÐ»Ð¾Ð²Ð° ÑÐ¸Ð»ÑÑÑÑÐµÐ¼ Ð½Ð° ÐºÐ»Ð¸ÐµÐ½ÑÐµ Ð´Ð»Ñ ÑÐ¾ÑÐ½Ð¾ÑÑÐ¸
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

/** ÐÐ¾Ð´ÑÑÑÑ ÑÐµÐ»ÐµÐ²Ð°Ð½ÑÐ½Ð¾ÑÑÐ¸ FTS: ÑÐºÐ¾Ð»ÑÐºÐ¾ ÑÐ»Ð¾Ð² Ð·Ð°Ð¿ÑÐ¾ÑÐ° ÑÐ¾Ð²Ð¿Ð°Ð»Ð¾ */
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

  // ÐÐ¾ÑÐ¼Ð°Ð»Ð¸Ð·ÑÐµÐ¼: Ð²ÑÐµ ÑÐ»Ð¾Ð²Ð° ÑÐ¾Ð²Ð¿Ð°Ð»Ð¸ = 1.0, + Ð±Ð¾Ð½ÑÑ Ð·Ð° Ð¸Ð¼Ñ ÑÐ°Ð¹Ð»Ð°
  let score = matched / words.length;
  const filenameLower = (row.filename ?? "").toLowerCase();
  if (words.some((w) => filenameLower.includes(w))) {
    score += FTS_BOOST;
  }

  return Math.min(score, 1.0);
}

/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */
/* Ð¡ÐµÐ¼Ð°Ð½ÑÐ¸ÑÐµÑÐºÐ¸Ð¹ Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾ chunks â Ð³ÑÑÐ¿Ð¿Ð¸ÑÐ¾Ð²ÐºÐ° Ð¿Ð¾ source_id                  */
/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

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

  // ÐÑÐ¿Ð¾Ð»ÑÐ·ÑÐµÐ¼ ÑÑÑÐµÑÑÐ²ÑÑÑÑÑ RPC-ÑÑÐ½ÐºÑÐ¸Ñ hybrid_search
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: limit * 3, // Ð±ÐµÑÑÐ¼ Ð±Ð¾Ð»ÑÑÐµ, Ñ.Ðº. Ð¿Ð¾ÑÐ¾Ð¼ Ð³ÑÑÐ¿Ð¿Ð¸ÑÑÐµÐ¼
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: null,
  });

  if (error) {
    console.error("Semantic search error:", error);
    return results;
  }

  // ÐÐ°Ð³ÑÑÐ¶Ð°ÐµÐ¼ Ð¼ÐµÑÐ°Ð´Ð°Ð½Ð½ÑÐµ Ð¸ÑÑÐ¾ÑÐ½Ð¸ÐºÐ¾Ð² Ð´Ð»Ñ Ð½Ð°Ð¹Ð´ÐµÐ½Ð½ÑÑ ÑÐ°Ð½ÐºÐ¾Ð²
  const chunkRows = (data ?? []) as SemanticRow[];
  const sourceIds = [...new Set(chunkRows.map((r) => r.source_id))];

  if (sourceIds.length === 0) return results;

  // ÐÐ¾Ð»ÑÑÐ°ÐµÐ¼ sources
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

  // ÐÑÑÐ¿Ð¿Ð¸ÑÑÐµÐ¼ ÑÐ°Ð½ÐºÐ¸ Ð¿Ð¾ source_id
  for (const chunk of chunkRows) {
    const source = sourcesMap.get(chunk.source_id);
    if (!source) continue; // Ð¸ÑÑÐ¾ÑÐ½Ð¸Ðº Ð¾ÑÑÐ¸Ð»ÑÑÑÐ¾Ð²Ð°Ð½ Ð¿Ð¾ folder

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

/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */
/* ÐÐ±ÑÐµÐ´Ð¸Ð½ÐµÐ½Ð¸Ðµ FTS + Semantic                                                */
/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

function mergeResults(
  ftsMap: Map<string, KBSearchResult>,
  semanticMap: Map<string, KBSearchResult>,
  limit: number
): KBSearchResult[] {
  const merged = new Map<string, KBSearchResult>();

  // Ð¡Ð½Ð°ÑÐ°Ð»Ð° Ð´Ð¾Ð±Ð°Ð²Ð»ÑÐµÐ¼ ÑÐµÐ¼Ð°Ð½ÑÐ¸ÑÐµÑÐºÐ¸Ðµ (Ð¾ÑÐ½Ð¾Ð²Ð½Ð¾Ð¹ Ð¿ÑÐ¸Ð¾ÑÐ¸ÑÐµÑ)
  for (const [id, result] of semanticMap) {
    merged.set(id, result);
  }

  // ÐÐ¾Ð±Ð°Ð²Ð»ÑÐµÐ¼ / Ð¾Ð±Ð¾Ð³Ð°ÑÐ°ÐµÐ¼ Ð¸Ð· FTS
  for (const [id, ftsResult] of ftsMap) {
    const existing = merged.get(id);
    if (existing) {
      // ÐÐ¾ÐºÑÐ¼ÐµÐ½Ñ Ð½Ð°Ð¹Ð´ÐµÐ½ Ð¾Ð±Ð¾Ð¸Ð¼Ð¸ ÑÐ¿Ð¾ÑÐ¾Ð±Ð°Ð¼Ð¸ â Ð¿Ð¾Ð²ÑÑÐ°ÐµÐ¼ score
      existing.match_type = "both";
      existing.similarity = Math.min(
        existing.similarity + FTS_BOOST,
        1.0
      );
    } else {
      merged.set(id, ftsResult);
    }
  }

  // Ð¡Ð¾ÑÑÐ¸ÑÑÐµÐ¼: ÑÐ½Ð°ÑÐ°Ð»Ð° both > semantic > fts, Ð·Ð°ÑÐµÐ¼ Ð¿Ð¾ similarity
  const typeOrder: Record<string, number> = { both: 3, semantic: 2, fts: 1 };
  const sorted = Array.from(merged.values()).sort((a, b) => {
    const typeDiff = (typeOrder[b.match_type] ?? 0) - (typeOrder[a.match_type] ?? 0);
    if (typeDiff !== 0) return typeDiff;
    return b.similarity - a.similarity;
  });

  return sorted.slice(0, limit);
}
