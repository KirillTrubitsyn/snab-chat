-- ============================================================
-- Migration: vector_search_in_source RPC (PR #7)
-- Scoped vector search inside a single document — used by
-- chat.ts per-entity DOC pre-seed to return TOP-N semantically
-- relevant chunks from one document (e.g. Положение НТСК), rather
-- than the first N chunks by chunk_index ASC.
--
-- Why this exists
-- ---------------
-- fetchChunksByDocument returns chunks ordered by chunk_index ASC,
-- so the first 3-6 chunks of any normative document are always
-- the cover page + logo + title. The substantive sections
-- (способы закупок, пороги одобрения, требования к участникам)
-- live further inside, around chunk_index 10-30. To compare the
-- procurement procedures of ЕТГК vs НТСК, the LLM needs to see
-- those substantive sections, not the title page.
--
-- This RPC takes a precomputed query embedding (so the caller can
-- reuse the same embedding across multiple source_ids without
-- paying for an embed call per source) and returns the top-N
-- chunks from the specified source_id, ranked by cosine
-- similarity to the query.
--
-- Same return shape as hybrid_search so callers can treat results
-- interchangeably in the candidate pool.
-- ============================================================

DROP FUNCTION IF EXISTS vector_search_in_source(vector, bigint, integer);

CREATE OR REPLACE FUNCTION vector_search_in_source(
  query_embedding vector(1536),
  target_source_id bigint,
  match_count integer DEFAULT 6
)
RETURNS TABLE (
  id text,
  content text,
  source_filename text,
  chunk_index integer,
  similarity float,
  tags text[],
  image_paths text[]
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id::text AS id,
    c.content,
    c.source_filename,
    c.chunk_index,
    (1 - (c.embedding <=> query_embedding))::float AS similarity,
    c.tags,
    c.image_paths
  FROM chunks c
  WHERE c.embedding IS NOT NULL
    AND c.source_id = target_source_id
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION vector_search_in_source(vector, bigint, integer)
  TO anon, authenticated, service_role;
