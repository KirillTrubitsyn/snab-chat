-- Миграция: таблица login_approvals для push-уведомлений при входе через Telegram
-- Выполнить в Supabase SQL Editor

-- 1. Таблица запросов на подтверждение входа
CREATE TABLE IF NOT EXISTS login_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_id UUID NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '5 minutes'),
  resolved_at TIMESTAMPTZ
);

-- Индекс для быстрого поиска pending approvals
CREATE INDEX IF NOT EXISTS idx_login_approvals_pending
  ON login_approvals (invite_code_id, status)
  WHERE status = 'pending';

-- RLS
ALTER TABLE login_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_login_approvals" ON login_approvals
  FOR ALL TO anon USING (false);
