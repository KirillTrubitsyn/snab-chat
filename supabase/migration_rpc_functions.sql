-- ============================================================
-- Миграция: создание RPC-функций для поиска
-- hybrid_search, hybrid_search_with_parent, get_sibling_chunks
-- Применить в Supabase SQL Editor
-- ============================================================

-- 1. hybrid_search (базовая, с поддержкой case-insensitive тегов и image_paths)
DROP FUNCTION IF EXISTS hybrid_search(text, vector, integer, double precision, double precision, text[]);

CREATE OR REPLACE FUNCTION hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_count integer DEFAULT 20,
  vector_weight float DEFAULT 0.7,
  fts_weight float DEFAULT 0.3,
  filter_tags text[] DEFAULT NULL
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
DECLARE
  normalized_tags text[];
BEGIN
  IF filter_tags IS NOT NULL THEN
    SELECT array_agg(lower(t)) INTO normalized_tags FROM unnest(filter_tags) AS t;
  END IF;

  RETURN QUERY
  WITH vector_results AS (
    SELECT
      c.id::text AS id,
      c.content,
      c.source_filename,
      c.chunk_index,
      c.tags,
      c.image_paths,
      1 - (c.embedding <=> query_embedding) AS vector_score
    FROM chunks c
    WHERE c.embedding IS NOT NULL
      AND (normalized_tags IS NULL OR
        (SELECT array_agg(lower(t)) FROM unnest(c.tags) AS t) && normalized_tags)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  fts_results AS (
    SELECT
      c.id::text AS id,
      c.content,
      c.source_filename,
      c.chunk_index,
      c.tags,
      c.image_paths,
      ts_rank_cd(c.fts, plainto_tsquery('russian', query_text)) AS fts_score
    FROM chunks c
    WHERE c.fts @@ plainto_tsquery('russian', query_text)
      AND (normalized_tags IS NULL OR
        (SELECT array_agg(lower(t)) FROM unnest(c.tags) AS t) && normalized_tags)
    LIMIT match_count * 2
  ),
  combined AS (
    SELECT
      COALESCE(v.id, f.id) AS id,
      COALESCE(v.content, f.content) AS content,
      COALESCE(v.source_filename, f.source_filename) AS source_filename,
      COALESCE(v.chunk_index, f.chunk_index) AS chunk_index,
      COALESCE(v.tags, f.tags) AS tags,
      COALESCE(v.image_paths, f.image_paths) AS image_paths,
      (
        COALESCE(v.vector_score, 0) * vector_weight +
        COALESCE(f.fts_score, 0) * fts_weight
      ) AS combined_score
    FROM vector_results v
    FULL OUTER JOIN fts_results f ON v.id = f.id
  )
  SELECT
    combined.id,
    combined.content,
    combined.source_filename,
    combined.chunk_index,
    combined.combined_score AS similarity,
    combined.tags,
    combined.image_paths
  FROM combined
  ORDER BY combined.combined_score DESC
  LIMIT match_count;
END;
$$;

-- 2. hybrid_search_with_parent (добавляет parent_group_key и source_id)
DROP FUNCTION IF EXISTS hybrid_search_with_parent(text, vector, integer, double precision, double precision, text[]);

CREATE OR REPLACE FUNCTION hybrid_search_with_parent(
  query_text text,
  query_embedding vector(1536),
  match_count integer DEFAULT 20,
  vector_weight float DEFAULT 0.7,
  fts_weight float DEFAULT 0.3,
  filter_tags text[] DEFAULT NULL
)
RETURNS TABLE (
  id text,
  content text,
  source_filename text,
  chunk_index integer,
  similarity float,
  tags text[],
  image_paths text[],
  parent_group_key text,
  source_id bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    hs.id,
    hs.content,
    hs.source_filename,
    hs.chunk_index,
    hs.similarity,
    hs.tags,
    hs.image_paths,
    c.parent_group_key,
    c.source_id
  FROM hybrid_search(
    query_text, query_embedding, match_count,
    vector_weight, fts_weight, filter_tags
  ) hs
  JOIN chunks c ON c.id::text = hs.id;
END;
$$;

-- 3. get_sibling_chunks (получить все чанки по parent_group_key)
DROP FUNCTION IF EXISTS get_sibling_chunks(text, integer);

CREATE OR REPLACE FUNCTION get_sibling_chunks(
  p_parent_group_key text,
  p_max_siblings integer DEFAULT 30
)
RETURNS TABLE (
  content text,
  chunk_index integer
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT c.content, c.chunk_index
  FROM chunks c
  WHERE c.parent_group_key = p_parent_group_key
  ORDER BY c.chunk_index
  LIMIT p_max_siblings;
END;
$$;

-- Готово. Проверка:
-- SELECT * FROM hybrid_search('тест', '[0,0,...,0]'::vector(1536), 3);
-- SELECT * FROM get_sibling_chunks('критерии_способа_закупки_сгк_алтай::общий', 5);
