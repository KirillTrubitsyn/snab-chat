-- ============================================================
-- СнабЧат: Knowledge Graph — evaluation pipeline для extraction
-- Выполнить в Supabase SQL Editor ПОСЛЕ migration_knowledge_graph.sql.
-- ============================================================
-- kg_eval_gold — золотой датасет: для chunk_id экспертно размеченные
-- ожидаемые сущности и связи. Используется для измерения precision/
-- recall экстрактора после изменений промптов / онтологий.
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_eval_gold (
  id                   BIGSERIAL PRIMARY KEY,
  chunk_id             BIGINT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  domain               TEXT NOT NULL,  -- 'standards', 'contracts', 'authority_matrix', ...
  -- Формат expected_entities: [{name, type, description?}]
  expected_entities    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Формат expected_relations: [{source, target, type}]
  expected_relations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Источник эталона: 'manual' — ручная разметка, либо имя модели
  -- ('gemini-3-pro' и т.п.) при auto-seed через сильную модель.
  source               TEXT NOT NULL DEFAULT 'manual',
  notes                TEXT DEFAULT '',
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_kg_eval_gold_chunk UNIQUE (chunk_id)
);

-- Идемпотентное добавление колонки для существующих установок.
ALTER TABLE kg_eval_gold
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_kg_eval_gold_domain
  ON kg_eval_gold(domain);

-- ============================================================
-- kg_eval_run — история прогонов eval. metrics хранит детализацию
-- (per-domain / per-type precision, recall, F1).
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_eval_run (
  id                   BIGSERIAL PRIMARY KEY,
  run_at               TIMESTAMPTZ DEFAULT now(),
  total_chunks         INT NOT NULL DEFAULT 0,
  entity_precision     FLOAT,
  entity_recall        FLOAT,
  entity_f1            FLOAT,
  relation_precision   FLOAT,
  relation_recall      FLOAT,
  relation_f1          FLOAT,
  -- Детализация: {domains: {standards: {...}, ...}, entityTypes: {standard: {...}, ...}}
  metrics              JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes                TEXT DEFAULT '',
  model                TEXT DEFAULT 'gemini-3-flash-preview',
  -- Модель-эталон, против которой сравнивался model (manual / gemini-3-pro / ...).
  gold_model           TEXT DEFAULT 'manual'
);

-- Идемпотентное добавление колонки для существующих установок.
ALTER TABLE kg_eval_run
  ADD COLUMN IF NOT EXISTS gold_model TEXT DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_kg_eval_run_at
  ON kg_eval_run(run_at DESC);

-- ============================================================
-- Триггер на updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_kg_eval_gold_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kg_eval_gold_updated_at ON kg_eval_gold;
CREATE TRIGGER trg_kg_eval_gold_updated_at
  BEFORE UPDATE ON kg_eval_gold
  FOR EACH ROW
  EXECUTE FUNCTION update_kg_eval_gold_updated_at();
