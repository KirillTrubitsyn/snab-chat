-- ============================================================
-- СнабЧат — Миграция: лимит устройств для инвайт-кодов
-- Выполнить в Supabase SQL Editor
-- ============================================================

-- 1. Добавить колонку device_limit в invite_codes
-- null = безлимит (для админов), по умолчанию 2
ALTER TABLE invite_codes
  ADD COLUMN IF NOT EXISTS device_limit integer DEFAULT 2;

-- 2. Таблица устройств — привязка устройств к инвайт-кодам
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_id uuid NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  user_agent text DEFAULT '',
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(invite_code_id, device_id)
);

CREATE INDEX IF NOT EXISTS devices_invite_code_id_idx ON devices (invite_code_id);
