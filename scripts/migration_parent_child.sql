-- ============================================================
-- Миграция: Parent-Child чанкинг + ссылки на оригинальные файлы
-- Выполнить в Supabase SQL Editor (Dashboard → SQL Editor)
-- Дата: 2026-03-31
--
-- Схема: sources.id = bigint, chunks.id = bigint
-- ============================================================

-- ─── 1. Новые колонки в sources ─────────────────────────────
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS original_filename TEXT,
  ADD COLUMN IF NOT EXISTS original_file_url  TEXT;

COMMENT ON COLUMN sources.original_filename IS
  'Имя исходного файла до денормализации (напр. "КЭ-143 Положение о ЗКО.docx")';
COMMENT ON COLUMN sources.original_file_url IS
  'URL для скачивания оригинального файла (Supabase Storage или GitHub raw)';

-- ─── 2. Новая колонка в chunks ──────────────────────────────
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS parent_group_key TEXT;

COMMENT ON COLUMN chunks.parent_group_key IS
  'Ключ группировки child-чанков (напр. "КЭ-143_ЗКО::Таблица_4_Матрица_полномочий")';

-- ─── 3. Индексы ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chunks_parent_group_key
  ON chunks (parent_group_key)
  WHERE parent_group_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_original_filename
  ON sources (original_filename)
  WHERE original_filename IS NOT NULL;

-- ─── 4. RPC: получить sibling-чанки по parent_group_key ─────
CREATE OR REPLACE FUNCTION get_sibling_chunks(
  p_parent_group_key TEXT,
  p_max_siblings INT DEFAULT 30
)
RETURNS TABLE (
  id          BIGINT,
  content     TEXT,
  chunk_index INT,
  source_id   BIGINT,
  tags        TEXT[]
)
LANGUAGE sql STABLE
AS $$
  SELECT c.id, c.content, c.chunk_index, c.source_id, c.tags
  FROM chunks c
  WHERE c.parent_group_key = p_parent_group_key
  ORDER BY c.chunk_index
  LIMIT p_max_siblings;
$$;

-- ─── 5. RPC: hybrid_search с parent_group_key ───────────────
-- Обёртка поверх hybrid_search, дополняющая parent_group_key и source_id.
-- Реальная сигнатура hybrid_search:
--   (query_text text, query_embedding vector, match_count int,
--    vector_weight double precision, fts_weight double precision,
--    filter_tags text[])
--   → TABLE(id text, content text, source_filename text,
--           chunk_index int, similarity double precision,
--           tags text[], image_paths text[])
-- NB: hybrid_search возвращает id как text, а chunks.id — bigint.
CREATE OR REPLACE FUNCTION hybrid_search_with_parent(
  query_text      TEXT,
  query_embedding vector,
  match_count     INT DEFAULT 20,
  vector_weight   DOUBLE PRECISION DEFAULT 0.7,
  fts_weight      DOUBLE PRECISION DEFAULT 0.3,
  filter_tags     TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  id               TEXT,
  content          TEXT,
  source_id        BIGINT,
  source_filename  TEXT,
  similarity       DOUBLE PRECISION,
  tags             TEXT[],
  parent_group_key TEXT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    hs.id,
    hs.content,
    c.source_id,
    hs.source_filename,
    hs.similarity,
    hs.tags,
    c.parent_group_key
  FROM hybrid_search(
    query_text, query_embedding, match_count,
    vector_weight, fts_weight, filter_tags
  ) hs
  JOIN chunks c ON c.id::text = hs.id;
$$;

-- ─── 6. Проверка ────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('sources', 'chunks')
  AND column_name IN ('original_filename', 'original_file_url', 'parent_group_key')
ORDER BY table_name, column_name;
