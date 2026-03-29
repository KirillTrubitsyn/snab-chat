-- ============================================================
-- Миграция: мультимодальные чанки (image_paths)
-- Добавляет поле для хранения путей к изображениям в Storage
-- ============================================================

-- 1. Добавить колонку image_paths в таблицу chunks
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS image_paths text[] DEFAULT '{}';

-- 2. Создать bucket для изображений чанков (если не существует)
INSERT INTO storage.buckets (id, name, public)
VALUES ('chunk-images', 'chunk-images', false)
ON CONFLICT (id) DO NOTHING;

-- 3. Обновить RPC-функцию hybrid_search: добавить image_paths в результат
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
BEGIN
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
    WHERE (filter_tags IS NULL OR c.tags && filter_tags)
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
      AND (filter_tags IS NULL OR c.tags && filter_tags)
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
