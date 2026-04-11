-- ============================================================
-- Миграция: RPC-функция search_contractor_cards
-- Специализированный поиск по карточкам контрагентов.
-- Решает проблему pgvector HNSW-индекса: при фильтрации по тегам
-- индекс сканирует ВСЮ таблицу, затем фильтрует, что даёт 0 результатов.
-- Эта функция сначала фильтрует CTE по тегу, потом ищет.
-- Применить в Supabase SQL Editor.
-- ============================================================

DROP FUNCTION IF EXISTS search_contractor_cards(text, vector, integer);

CREATE OR REPLACE FUNCTION search_contractor_cards(
  query_text text,
  query_embedding vector(1536),
  match_count integer DEFAULT 20
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
AS $fn$
BEGIN
  RETURN QUERY
  WITH contractor_chunks AS (
    -- Шаг 1: Фильтрация ТОЛЬКО карточек контрагентов (до векторного поиска)
    SELECT c.*
    FROM chunks c
    WHERE c.embedding IS NOT NULL
      AND c.tags @> ARRAY['карточка контрагента']::text[]
  ),
  vector_results AS (
    -- Шаг 2: Векторный поиск внутри отфильтрованного набора
    SELECT
      cc.id::text AS vid,
      cc.content AS vcontent,
      cc.source_filename AS vfilename,
      cc.chunk_index AS vchunk_index,
      cc.tags AS vtags,
      cc.image_paths AS vimage_paths,
      1 - (cc.embedding <=> query_embedding) AS vector_score
    FROM contractor_chunks cc
    ORDER BY cc.embedding <=> query_embedding
    LIMIT match_count * 3
  ),
  fts_results AS (
    -- Шаг 3: Полнотекстовый поиск внутри отфильтрованного набора
    SELECT
      cc.id::text AS fid,
      cc.content AS fcontent,
      cc.source_filename AS ffilename,
      cc.chunk_index AS fchunk_index,
      cc.tags AS ftags,
      cc.image_paths AS fimage_paths,
      ts_rank_cd(cc.fts, plainto_tsquery('russian', query_text)) AS fts_score
    FROM contractor_chunks cc
    WHERE cc.fts @@ plainto_tsquery('russian', query_text)
    LIMIT match_count * 3
  ),
  combined AS (
    -- Шаг 4: Объединение результатов (70% вектор + 30% FTS)
    SELECT
      COALESCE(v.vid, f.fid) AS cid,
      COALESCE(v.vcontent, f.fcontent) AS ccontent,
      COALESCE(v.vfilename, f.ffilename) AS cfilename,
      COALESCE(v.vchunk_index, f.fchunk_index) AS cchunk_index,
      COALESCE(v.vtags, f.ftags) AS ctags,
      COALESCE(v.vimage_paths, f.fimage_paths) AS cimage_paths,
      (COALESCE(v.vector_score, 0) * 0.7 + COALESCE(f.fts_score, 0) * 0.3) AS combined_score
    FROM vector_results v
    FULL OUTER JOIN fts_results f ON v.vid = f.fid
  )
  SELECT
    combined.cid,
    combined.ccontent,
    combined.cfilename,
    combined.cchunk_index,
    combined.combined_score,
    combined.ctags,
    combined.cimage_paths
  FROM combined
  ORDER BY combined.combined_score DESC
  LIMIT match_count;
END;
$fn$;

-- Проверка:
-- SELECT id, source_filename, similarity
-- FROM search_contractor_cards(
--   'теплоизоляция',
--   (SELECT embedding FROM chunks WHERE id = (SELECT id FROM chunks LIMIT 1)),
--   5
-- );
