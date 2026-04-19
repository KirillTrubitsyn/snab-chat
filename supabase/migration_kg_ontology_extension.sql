-- ============================================================
-- СнабЧат: Knowledge Graph — расширение онтологии (P0)
-- Выполнить в Supabase SQL Editor ПОСЛЕ migration_knowledge_graph.sql.
-- Миграция additive: схема не меняется, обновляются только COMMENT'ы.
-- Новые entity_type / relation_type значения допустимы автоматически
-- (колонки TEXT без CHECK-ограничений).
-- ============================================================

-- Обновлённый список допустимых типов сущностей.
-- Добавлены: contract_party, obligation, approval_level.
COMMENT ON TABLE kg_entities IS 'Типы: standard, branch, mtr_type, procedure, system, organization, document, role, threshold, concept, regulation, section, contract_party, obligation, approval_level';

-- Обновлённый список допустимых типов связей.
-- Добавлены: party_of, obliged_to, penalized_by, approves, escalates_to.
COMMENT ON TABLE kg_relations IS 'Типы связей: defines, references, requires, governs, part_of, belongs_to, supersedes, amends, sets_threshold, restricts, delegates_to, requires_approval, party_of, obliged_to, penalized_by, approves, escalates_to';
