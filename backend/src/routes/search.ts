import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { hybridSearch } from "../lib/retrieval.js";
import { embedQuery } from "../lib/embeddings.js";
import { getInviteCodeFromHeader, requireAdmin, requireAuth } from "../lib/auth.js";
import { searchSchema, parseBody } from "../lib/validation.js";
import { unauthorizedResponse } from "../lib/api-helpers.js";

const router = Router();

// ────────────────────────────────────────────────────────────────────────────
// POST /api/search
// ────────────────────────────────────────────────────────────────────────────

router.post("/api/search", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return unauthorizedResponse(res);

    const parsed = parseBody(req.body, searchSchema, res);
    if (parsed.error) return;

    const results = await hybridSearch(parsed.data.query, parsed.data.topK ?? 20, parsed.data.tags ?? null);
    return res.json({ results });
  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/kb-search — комбинированный поиск по базе знаний.
// ────────────────────────────────────────────────────────────────────────────

export interface SiblingChunk {
  content: string;
  chunk_index: number;
}

export interface KBSearchResult {
  source_id: number | string;
  filename: string;
  folder_path: string | null;
  mime_type: string | null;
  tags: string[];
  content_preview: string | null;
  created_at: string;
  best_chunk: string | null;
  similarity: number;
  chunk_count: number;
  match_type: "fts" | "semantic" | "both";
  parent_group_key: string | null;
  sibling_chunks: SiblingChunk[];
  original_filename: string | null;
  original_file_url: string | null;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const FTS_BOOST = 0.15;
const MAX_SIBLINGS = 30;

router.post("/api/kb-search", async (req: Request, res: Response) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const body = req.body;
    const query: string = (body.query ?? "").trim();
    const limit: number = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const folder: string | null = body.folder ?? null;
    const includeSiblings: boolean = body.include_siblings ?? true;

    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const supabase = createServiceClient();

    // 1. Полнотекстовый поиск по sources
    const ftsResults = await searchSourcesByText(supabase, query, folder, limit);

    // 2. Семантический поиск по chunks
    const semanticResults = await searchSourcesBySemantic(supabase, query, folder, limit);

    // 3. Объединение и ранжирование
    const merged = mergeResults(ftsResults, semanticResults, limit);

    // 4. Подгрузка sibling-чанков (Parent-Child)
    if (includeSiblings) {
      await enrichWithSiblings(supabase, merged);
    }

    return res.json({ results: merged });
  } catch (err) {
    console.error("KB search error:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/debug-chunks
// ────────────────────────────────────────────────────────────────────────────

router.get("/api/debug-chunks", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const filename = (req.query.filename as string) || "SRM";

    const supabase = createServiceClient();

    // 1. Check sources
    const { data: sources, error: srcErr } = await supabase
      .from("sources")
      .select("id, filename, tags, created_at, storage_path, folder_path")
      .ilike("filename", `%${filename}%`)
      .order("created_at", { ascending: false })
      .limit(10);

    // 2. Check chunks for those sources
    const { data: chunks, error: chunkErr } = await supabase
      .from("chunks")
      .select("id, source_id, source_filename, chunk_index, tags, image_paths, created_at")
      .ilike("source_filename", `%${filename}%`)
      .order("created_at", { ascending: false })
      .limit(50);

    // 3. Check if embeddings exist
    const { data: embCheck, error: embErr } = await supabase
      .rpc("check_embeddings", { filename_pattern: `%${filename}%` })
      .single();

    let embeddingInfo = embCheck;
    if (embErr) {
      const { count: totalCount } = await supabase
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .ilike("source_filename", `%${filename}%`);

      embeddingInfo = {
        total_chunks: totalCount || 0,
        rpc_error: embErr.message,
      };
    }

    // 4. Test hybrid_search with a simple query
    const { data: searchResults, error: searchErr } = await supabase.rpc("hybrid_search", {
      query_text: filename,
      query_embedding: `[${new Array(1536).fill(0).join(",")}]`,
      match_count: 10,
      vector_weight: 0.0,
      fts_weight: 1.0,
      filter_tags: null,
    });

    // 5. Test with SRM tag filter
    const { data: filteredResults, error: filteredErr } = await supabase.rpc("hybrid_search", {
      query_text: filename,
      query_embedding: `[${new Array(1536).fill(0).join(",")}]`,
      match_count: 10,
      vector_weight: 0.0,
      fts_weight: 1.0,
      filter_tags: ["SRM"],
    });

    return res.json({
      sources: sources || [],
      sourcesError: srcErr?.message || null,
      chunks: (chunks || []).map((c: Record<string, unknown>) => ({
        ...c,
        image_paths_count: Array.isArray(c.image_paths) ? (c.image_paths as string[]).length : 0,
      })),
      chunksError: chunkErr?.message || null,
      embeddingInfo,
      searchUnfiltered: {
        results: (searchResults || []).map((r: Record<string, unknown>) => ({
          id: r.id,
          source_filename: r.source_filename,
          chunk_index: r.chunk_index,
          similarity: r.similarity,
          tags: r.tags,
          image_paths: r.image_paths,
        })),
        error: searchErr?.message || null,
      },
      searchWithSRMTag: {
        results: (filteredResults || []).map((r: Record<string, unknown>) => ({
          id: r.id,
          source_filename: r.source_filename,
          chunk_index: r.chunk_index,
          similarity: r.similarity,
          tags: r.tags,
        })),
        error: filteredErr?.message || null,
      },
    });
  } catch (err) {
    console.error("Debug chunks error:", err);
    return res.status(500).json({ error: "Debug failed" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Internal helpers for kb-search
// ════════════════════════════════════════════════════════════════════════════

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

  const { data, error } = await supabase.rpc("hybrid_search_with_parent", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: limit * 3,
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: null,
  });

  if (error) {
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

async function enrichWithSiblings(
  supabase: ReturnType<typeof createServiceClient>,
  results: KBSearchResult[]
): Promise<void> {
  const keysToFetch = new Set<string>();
  for (const r of results) {
    if (r.parent_group_key) {
      keysToFetch.add(r.parent_group_key);
    }
  }

  if (keysToFetch.size === 0) return;

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

  for (const r of results) {
    if (r.parent_group_key && siblingsMap.has(r.parent_group_key)) {
      r.sibling_chunks = siblingsMap.get(r.parent_group_key) ?? [];
    }
  }
}

export default router;
