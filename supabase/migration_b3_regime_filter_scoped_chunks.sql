-- ============================================================
-- B3 (recovery plan от 2026-04-20):
-- регим-фильтр в RPC kg_get_scoped_chunks.
--
-- Добавляет опциональный параметр p_exclude_tag, при котором все chunks
-- с этим тегом исключаются из результата ДО пост-обработки. Это убирает
-- архитектурный конфликт между graph traversal и regime post-filter,
-- при котором противоположный регим доходил до chat.ts и там обрезался
-- уже после формирования контекста.
--
-- Backward compat: p_exclude_tag DEFAULT NULL — существующие вызовы
-- без этого параметра работают как раньше.
-- ============================================================

CREATE OR REPLACE FUNCTION kg_get_scoped_chunks(
  entity_ids UUID[],
  max_chunks INT DEFAULT 200,
  p_exclude_tag TEXT DEFAULT NULL
)
RETURNS TABLE(chunk_id BIGINT)
LANGUAGE sql STABLE
AS $$
  WITH raw AS (
    SELECT DISTINCT unnest(e.source_chunk_ids) AS chunk_id
    FROM kg_entities e
    WHERE e.id = ANY(entity_ids)

    UNION

    SELECT DISTINCT r.source_chunk_id AS chunk_id
    FROM kg_relations r
    WHERE (r.source_entity_id = ANY(entity_ids) OR r.target_entity_id = ANY(entity_ids))
      AND r.source_chunk_id IS NOT NULL
  )
  SELECT raw.chunk_id
  FROM raw
  JOIN chunks c ON c.id = raw.chunk_id
  WHERE p_exclude_tag IS NULL
     OR NOT (c.tags @> ARRAY[p_exclude_tag])
  LIMIT max_chunks;
$$;

-- Заметка для TS-стороны (backend/src/lib/kg-search.ts):
-- При вызове RPC передавать p_exclude_tag = (intent.fz_type === '223' ? 'вне 223-фз'
--                                            : intent.fz_type === 'non-223' ? '223-фз'
--                                            : NULL).
