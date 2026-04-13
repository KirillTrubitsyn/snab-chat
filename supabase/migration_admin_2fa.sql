-- ============================================================
-- Миграция: Обязательная 2FA для админов
-- Выполнить в Supabase SQL Editor
-- ============================================================

-- 1. Таблица 2FA-данных админов (ключ — admin_number из ADMIN_CODES_JSON)
CREATE TABLE IF NOT EXISTS admin_2fa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_number INTEGER NOT NULL UNIQUE,
  totp_secret TEXT DEFAULT NULL,
  telegram_chat_id TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_2fa_number ON admin_2fa (admin_number);

ALTER TABLE admin_2fa ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_admin_2fa" ON admin_2fa FOR ALL TO anon USING (false);

-- 2. OTP-коды для админов (отдельно от otp_codes, т.к. там FK на invite_codes)
CREATE TABLE IF NOT EXISTS admin_otp_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_number INTEGER NOT NULL,
  code TEXT NOT NULL,
  method TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_otp_codes_number ON admin_otp_codes (admin_number);

ALTER TABLE admin_otp_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_admin_otp_codes" ON admin_otp_codes FOR ALL TO anon USING (false);

-- 3. Сессии админов (токены после прохождения 2FA)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_number INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_hash ON admin_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_admin_sessions" ON admin_sessions FOR ALL TO anon USING (false);
