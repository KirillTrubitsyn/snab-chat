-- =============================================================
-- Миграция: RLS Fix (2026-04-14)
-- Закрывает все уязвимости из Supabase Security Advisor:
--   ERRORS:   RLS Disabled In Public (kg_entities, kg_relations,
--             kg_extraction_log, security_events)
--   INFO:     RLS Enabled No Policy (audit_log, error_logs,
--             off_topic_queries, support_messages)
-- Выполнить в Supabase SQL Editor ОДИН РАЗ
-- =============================================================

-- ── 1. Таблицы с ОТКЛЮЧЁННЫМ RLS (ERRORS) ──────────────────

ALTER TABLE IF EXISTS kg_entities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS kg_relations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS kg_extraction_log  ENABLE ROW LEVEL SECURITY;

-- security_events — может называться иначе; применяем безопасно
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'security_events') THEN
    EXECUTE 'ALTER TABLE security_events ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- ── 2. Политики запрета анонимного доступа ──────────────────

-- kg_entities
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename = 'kg_entities' AND policyname = 'deny_anon_kg_entities')
  THEN DROP POLICY "deny_anon_kg_entities" ON kg_entities; END IF;
END $$;
CREATE POLICY "deny_anon_kg_entities"
  ON kg_entities FOR ALL TO anon USING (false);

-- kg_relations
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename = 'kg_relations' AND policyname = 'deny_anon_kg_relations')
  THEN DROP POLICY "deny_anon_kg_relations" ON kg_relations; END IF;
END $$;
CREATE POLICY "deny_anon_kg_relations"
  ON kg_relations FOR ALL TO anon USING (false);

-- kg_extraction_log
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename = 'kg_extraction_log' AND policyname = 'deny_anon_kg_extraction_log')
  THEN DROP POLICY "deny_anon_kg_extraction_log" ON kg_extraction_log; END IF;
END $$;
CREATE POLICY "deny_anon_kg_extraction_log"
  ON kg_extraction_log FOR ALL TO anon USING (false);

-- security_events (если таблица существует)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'security_events') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE tablename = 'security_events'
                   AND policyname = 'deny_anon_security_events') THEN
      EXECUTE 'CREATE POLICY "deny_anon_security_events"
               ON security_events FOR ALL TO anon USING (false)';
    END IF;
  END IF;
END $$;

-- ── 3. Таблицы с RLS включённым, но без политик (INFO) ──────

-- audit_log
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename = 'audit_log' AND policyname = 'deny_anon_audit_log')
  THEN DROP POLICY "deny_anon_audit_log" ON audit_log; END IF;
END $$;
CREATE POLICY "deny_anon_audit_log"
  ON audit_log FOR ALL TO anon USING (false);

-- error_logs
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename = 'error_logs' AND policyname = 'deny_anon_error_logs')
  THEN DROP POLICY "deny_anon_error_logs" ON error_logs; END IF;
END $$;
CREATE POLICY "deny_anon_error_logs"
  ON error_logs FOR ALL TO anon USING (false);

-- off_topic_queries
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename = 'off_topic_queries' AND policyname = 'deny_anon_off_topic_queries')
  THEN DROP POLICY "deny_anon_off_topic_queries" ON off_topic_queries; END IF;
END $$;
CREATE POLICY "deny_anon_off_topic_queries"
  ON off_topic_queries FOR ALL TO anon USING (false);

-- support_messages
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename = 'support_messages' AND policyname = 'deny_anon_support_messages')
  THEN DROP POLICY "deny_anon_support_messages" ON support_messages; END IF;
END $$;
CREATE POLICY "deny_anon_support_messages"
  ON support_messages FOR ALL TO anon USING (false);

-- ── 4. Проверка результата ───────────────────────────────────
-- После выполнения этот запрос должен вернуть 0 строк:
-- SELECT tablename FROM pg_tables
-- WHERE schemaname = 'public'
--   AND rowsecurity = false
--   AND tablename NOT LIKE 'pg_%';
