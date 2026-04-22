-- ============================================================
-- Fix Supabase Security Advisor warning 0011_function_search_path_mutable.
--
-- Two public functions had mutable search_path:
--   - public.update_kg_eval_gold_updated_at (trigger function)
--   - public.kg_get_scoped_chunks          (KG scoped-chunk RPC)
--
-- Without SET search_path an attacker with CREATE privilege on any schema
-- in the caller's search_path could shadow built-ins (e.g. now(), operators)
-- and hijack the function's resolution. Pin search_path to a fixed,
-- trusted list. Bodies are unchanged; only the SET clause is added.
-- Safe to re-apply: CREATE OR REPLACE keeps object identity.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Trigger function for kg_eval_gold.updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_kg_eval_gold_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 2. KG RPC: scoped chunks with optional regime-tag exclusion
--    Body copied verbatim from migration_b3_regime_filter_scoped_chunks.sql
--    (the active version used by backend/src/lib/kg-search.ts).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kg_get_scoped_chunks(
  entity_ids UUID[],
  max_chunks INT DEFAULT 200,
  p_exclude_tag TEXT DEFAULT NULL
)
RETURNS TABLE(chunk_id BIGINT)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
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

-- ------------------------------------------------------------
-- Verification (read-only):
--   SELECT proname, proconfig
--   FROM pg_proc
--   WHERE proname IN ('update_kg_eval_gold_updated_at','kg_get_scoped_chunks');
--   -- proconfig should contain {search_path=public, pg_catalog}
-- ------------------------------------------------------------
