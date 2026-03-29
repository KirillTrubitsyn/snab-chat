import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const { searchParams } = new URL(req.url);
  const filename = searchParams.get("filename") || "SRM";

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

  // 3. Check if embeddings exist (embedding is not null)
  const { data: embCheck, error: embErr } = await supabase
    .rpc("check_embeddings", { filename_pattern: `%${filename}%` })
    .single();

  // Fallback: raw count query if RPC doesn't exist
  let embeddingInfo = embCheck;
  if (embErr) {
    // Direct query: count chunks with/without embeddings
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
    query_embedding: `[${new Array(1536).fill(0).join(",")}]`, // zero vector just to test
    match_count: 10,
    vector_weight: 0.0, // only FTS for diagnostic
    fts_weight: 1.0,
    filter_tags: null, // no filter
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

  return NextResponse.json({
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
}
