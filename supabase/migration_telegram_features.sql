-- =====================================================
-- СнабЧат — Миграция: Telegram-уведомления + контроль
-- Три новые таблицы: off_topic_queries, support_messages, error_logs
-- =====================================================

-- 1. Таблица нецелевых запросов (LLM-классифицированные)
CREATE TABLE IF NOT EXISTS off_topic_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_id UUID REFERENCES invite_codes(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  organization TEXT,
  category TEXT NOT NULL,
  query_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_off_topic_created ON off_topic_queries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_off_topic_category ON off_topic_queries(category);

-- 2. Таблица обращений в поддержку
CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_id UUID REFERENCES invite_codes(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  organization TEXT,
  message TEXT NOT NULL,
  admin_reply TEXT,
  admin_number INT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  replied_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_created ON support_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_messages(status);

-- 3. Таблица логов ошибок
CREATE TABLE IF NOT EXISTS error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  endpoint TEXT,
  user_name TEXT,
  organization TEXT,
  invite_code_id UUID REFERENCES invite_codes(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_errors_created ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_type ON error_logs(error_type);
