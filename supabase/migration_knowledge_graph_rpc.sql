-- ============================================================
-- СнабЧат: Knowledge Graph — RPC-функции поиска и обхода
-- Выполнить в Supabase SQL Editor ПОСЛЕ migration_knowledge_graph.sql
-- ============================================================

-- ============================================================
-- 1. Семантический поиск сущностей по эмбеддингу запроса
-- ============================================================
CREATE OR REPLACE FUNCTION kg_search_entities(
  query_embedding vector(1536),
  match_count INT DEFAULT 5,
  filter_types TEXT[] DEFAULT NULL
)
RETURNS TABLE(
  entity_id UUID,
  name TEXT,
  canonical_name TEXT,
  entity_type TEXT,
  description TEXT,
  similarity FLOAT,
  source_chunk_ids BIGINT[],
  source_ids BIGINT[]
)
LANGUAGE sql STABLE
AS $$
  SELECT
    e.id AS entity_id,
    e.name,
    e.canonical_name,
    e.entity_type,
    e.description,
    1 - (e.embedding <=> query_embedding) AS similarity,
    e.source_chunk_ids,
    e.source_ids
  FROM kg_entities e
  WHERE e.embedding IS NOT NULL
    AND (filter_types IS NULL OR e.entity_type = ANY(filter_types))
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ============================================================
-- 2. Поиск сущностей по точному/частичному имени
-- ============================================================
CREATE OR REPLACE FUNCTION kg_find_entity_by_name(
  search_name TEXT,
  filter_types TEXT[] DEFAULT NULL
)
RETURNS TABLE(
  entity_id UUID,
  name TEXT,
  canonical_name TEXT,
  entity_type TEXT,
  description TEXT,
  source_chunk_ids BIGINT[],
  source_ids BIGINT[]
)
LANGUAGE sql STABLE
AS $$
  SELECT
    e.id AS entity_id,
    e.name,
    e.canonical_name,
    e.entity_type,
    e.description,
    e.source_chunk_ids,
    e.source_ids
  FROM kg_entities e
  WHERE (
    e.canonical_name = lower(trim(search_name))
    OR e.canonical_name ILIKE '%' || trim(search_name) || '%'
  )
  AND (filter_types IS NULL OR e.entity_type = ANY(filter_types))
  ORDER BY
    CASE WHEN e.canonical_name = lower(trim(search_name)) THEN 0 ELSE 1 END,
    length(e.canonical_name)
  LIMIT 10;
$$;

-- ============================================================
-- 3. Обход графа (BFS до N хопов)
-- ============================================================
CREATE OR REPLACE FUNCTION kg_traverse(
  start_entity_ids UUID[],
  max_hops INT DEFAULT 2,
  filter_relation_types TEXT[] DEFAULT NULL
)
RETURNS TABLE(
  entity_id UUID,
  name TEXT,
  canonical_name TEXT,
  entity_type TEXT,
  description TEXT,
  relation_type TEXT,
  relation_description TEXT,
  confidence FLOAT,
  hop INT,
  from_entity_id UUID,
  source_chunk_id BIGINT
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE graph_walk AS (
    -- Стартовые узлы (hop 0)
    SELECT
      e.id AS entity_id,
      e.name,
      e.canonical_name,
      e.entity_type,
      e.description,
      NULL::TEXT AS relation_type,
      NULL::TEXT AS relation_description,
      1.0::FLOAT AS confidence,
      0 AS hop,
      NULL::UUID AS from_entity_id,
      NULL::UUID AS source_chunk_id
    FROM kg_entities e
    WHERE e.id = ANY(start_entity_ids)

    UNION ALL

    -- Рекурсивный шаг: исходящие и входящие рёбра
    SELECT
      next_e.id,
      next_e.name,
      next_e.canonical_name,
      next_e.entity_type,
      next_e.description,
      r.relation_type,
      r.description,
      r.confidence,
      gw.hop + 1,
      gw.entity_id,
      r.source_chunk_id
    FROM graph_walk gw
    JOIN kg_relations r ON (
      r.source_entity_id = gw.entity_id
      OR r.target_entity_id = gw.entity_id
    )
    JOIN kg_entities next_e ON (
      next_e.id = CASE
        WHEN r.source_entity_id = gw.entity_id THEN r.target_entity_id
        ELSE r.source_entity_id
      END
    )
    WHERE gw.hop < LEAST(max_hops, 3)  -- жёсткий лимит 3 хопа
      AND next_e.id != ALL(start_entity_ids)  -- не возвращаться в старт
      AND (filter_relation_types IS NULL OR r.relation_type = ANY(filter_relation_types))
  )
  SELECT DISTINCT ON (entity_id)
    entity_id, name, canonical_name, entity_type, description,
    relation_type, relation_description, confidence,
    hop, from_entity_id, source_chunk_id
  FROM graph_walk
  WHERE hop > 0  -- не включать стартовые узлы
  ORDER BY entity_id, hop, confidence DESC;
$$;

-- ============================================================
-- 4. Сбор chunk_id из графа (для scope-фильтра в hybrid_search)
-- ============================================================
CREATE OR REPLACE FUNCTION kg_get_scoped_chunks(
  entity_ids UUID[],
  max_chunks INT DEFAULT 200
)
RETURNS TABLE(chunk_id BIGINT)
LANGUAGE sql STABLE
AS $$
  -- chunk_id напрямую из сущностей
  SELECT DISTINCT unnest(e.source_chunk_ids) AS chunk_id
  FROM kg_entities e
  WHERE e.id = ANY(entity_ids)

  UNION

  -- chunk_id из связей, где участвуют эти сущности
  SELECT DISTINCT r.source_chunk_id AS chunk_id
  FROM kg_relations r
  WHERE (r.source_entity_id = ANY(entity_ids) OR r.target_entity_id = ANY(entity_ids))
    AND r.source_chunk_id IS NOT NULL

  LIMIT max_chunks;
$$;

-- ============================================================
-- 5. Гибридный поиск с ограничением по scope (chunk_ids из графа)
-- ============================================================
CREATE OR REPLACE FUNCTION hybrid_search_scoped(
  query_text TEXT,
  query_embedding vector(1536),
  p_chunk_ids BIGINT[],
  match_count INT DEFAULT 15,
  vector_weight FLOAT DEFAULT 0.7,
  fts_weight FLOAT DEFAULT 0.3
)
RETURNS TABLE(
  id TEXT,
  content TEXT,
  source_filename TEXT,
  chunk_index INT,
  similarity FLOAT,
  tags TEXT[],
  image_paths TEXT[]
)
LANGUAGE sql STABLE
AS $$
  WITH scoped_chunks AS (
    SELECT c.*
    FROM chunks c
    WHERE c.id = ANY(p_chunk_ids)
  ),
  vector_results AS (
    SELECT
      sc.id::text,
      sc.content,
      sc.source_filename,
      sc.chunk_index,
      1 - (sc.embedding <=> query_embedding) AS vector_score,
      sc.tags,
      COALESCE(sc.image_paths, '{}') AS image_paths
    FROM scoped_chunks sc
    WHERE sc.embedding IS NOT NULL
    ORDER BY sc.embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  fts_results AS (
    SELECT
      sc.id::text,
      sc.content,
      sc.source_filename,
      sc.chunk_index,
      ts_rank_cd(
        COALESCE(sc.fts, to_tsvector('russian', sc.content)),
        plainto_tsquery('russian', query_text)
      ) +
      ts_rank_cd(
        COALESCE(sc.fts_simple, to_tsvector('simple', sc.content)),
        plainto_tsquery('simple', query_text)
      ) AS fts_score,
      sc.tags,
      COALESCE(sc.image_paths, '{}') AS image_paths
    FROM scoped_chunks sc
    WHERE
      COALESCE(sc.fts, to_tsvector('russian', sc.content)) @@ plainto_tsquery('russian', query_text)
      OR COALESCE(sc.fts_simple, to_tsvector('simple', sc.content)) @@ plainto_tsquery('simple', query_text)
  ),
  combined AS (
    SELECT
      COALESCE(v.id, f.id) AS id,
      COALESCE(v.content, f.content) AS content,
      COALESCE(v.source_filename, f.source_filename) AS source_filename,
      COALESCE(v.chunk_index, f.chunk_index) AS chunk_index,
      (COALESCE(v.vector_score, 0) * vector_weight +
       COALESCE(f.fts_score, 0) * fts_weight) AS combined_score,
      COALESCE(v.tags, f.tags) AS tags,
      COALESCE(v.image_paths, f.image_paths) AS image_paths
    FROM vector_results v
    FULL OUTER JOIN fts_results f ON v.id = f.id
  )
  SELECT
    id, content, source_filename, chunk_index,
    combined_score AS similarity,
    tags, image_paths
  FROM combined
  ORDER BY combined_score DESC
  LIMIT match_count;
$$;

-- ============================================================
-- 6. Статистика графа знаний
-- ============================================================
CREATE OR REPLACE FUNCTION kg_stats()
RETURNS TABLE(
  total_entities BIGINT,
  total_relations BIGINT,
  total_extracted_chunks BIGINT,
  entities_with_embeddings BIGINT,
  entity_types JSONB,
  relation_types JSONB
)
LANGUAGE sql STABLE
AS $$
  SELECT
    (SELECT count(*) FROM kg_entities),
    (SELECT count(*) FROM kg_relations),
    (SELECT count(*) FROM kg_extraction_log),
    (SELECT count(*) FROM kg_entities WHERE embedding IS NOT NULL),
    (SELECT jsonb_object_agg(entity_type, cnt)
     FROM (SELECT entity_type, count(*) AS cnt FROM kg_entities GROUP BY entity_type) sub),
    (SELECT jsonb_object_agg(relation_type, cnt)
     FROM (SELECT relation_type, count(*) AS cnt FROM kg_relations GROUP BY relation_type) sub);
$$;
