-- ============================================================
-- СнабЧат: Knowledge Graph — таблицы сущностей и связей
-- Выполнить в Supabase SQL Editor
-- ============================================================

-- 1. Таблица сущностей (узлы графа)
CREATE TABLE IF NOT EXISTS kg_entities (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  description     TEXT DEFAULT '',
  source_chunk_ids BIGINT[] DEFAULT '{}',
  source_ids      BIGINT[] DEFAULT '{}',
  embedding       vector(1536),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT uq_entity_canonical UNIQUE (canonical_name, entity_type)
);

-- Допустимые типы сущностей (закупочная онтология)
COMMENT ON TABLE kg_entities IS 'Типы: standard, branch, mtr_type, procedure, system, organization, document, role, threshold, concept, regulation, section';

-- 2. Таблица связей (рёбра графа)
CREATE TABLE IF NOT EXISTS kg_relations (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_entity_id  UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  target_entity_id  UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation_type     TEXT NOT NULL,
  description       TEXT DEFAULT '',
  confidence        FLOAT DEFAULT 1.0,
  source_chunk_id   BIGINT,
  source_id         BIGINT,
  created_at        TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT chk_no_self_loop CHECK (source_entity_id != target_entity_id)
);

COMMENT ON TABLE kg_relations IS 'Типы связей: defines, references, requires, governs, part_of, belongs_to, supersedes, amends, sets_threshold, restricts, delegates_to, requires_approval';

-- 3. Таблица прогресса извлечения (чтобы не обрабатывать чанки повторно)
CREATE TABLE IF NOT EXISTS kg_extraction_log (
  chunk_id    BIGINT PRIMARY KEY,
  source_id   BIGINT,
  entities_count INT DEFAULT 0,
  relations_count INT DEFAULT 0,
  extracted_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Индексы
-- ============================================================

-- Поиск по имени сущности
CREATE INDEX IF NOT EXISTS idx_kg_entities_canonical
  ON kg_entities(canonical_name);

-- Поиск по типу сущности
CREATE INDEX IF NOT EXISTS idx_kg_entities_type
  ON kg_entities(entity_type);

-- Векторный поиск по эмбеддингам сущностей (HNSW, cosine)
CREATE INDEX IF NOT EXISTS idx_kg_entities_embedding
  ON kg_entities USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Обход графа: быстрый поиск рёбер от/к сущности
CREATE INDEX IF NOT EXISTS idx_kg_relations_source
  ON kg_relations(source_entity_id);

CREATE INDEX IF NOT EXISTS idx_kg_relations_target
  ON kg_relations(target_entity_id);

-- Фильтрация по типу связи
CREATE INDEX IF NOT EXISTS idx_kg_relations_type
  ON kg_relations(relation_type);

-- Поиск по chunk_id в логе извлечения
CREATE INDEX IF NOT EXISTS idx_kg_extraction_log_source
  ON kg_extraction_log(source_id);

-- ============================================================
-- Триггер обновления updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_kg_entities_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_kg_entities_updated_at
  BEFORE UPDATE ON kg_entities
  FOR EACH ROW
  EXECUTE FUNCTION update_kg_entities_updated_at();
