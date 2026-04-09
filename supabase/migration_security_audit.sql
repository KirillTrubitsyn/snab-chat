-- =============================================================
-- Миграция: Security Audit (2026-04-09)
-- Выполнить в Supabase SQL Editor ОДИН РАЗ
-- =============================================================

-- 1. Включить RLS на всех таблицах (безопасно при повторном запуске)
ALTER TABLE IF EXISTS sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS infographics ENABLE ROW LEVEL SECURITY;

-- 2. Удалить старые политики (если есть) и создать новые
DO $$
BEGIN
  -- sources
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sources' AND policyname = 'deny_anon_sources') THEN
    DROP POLICY "deny_anon_sources" ON sources;
  END IF;
  -- chunks
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chunks' AND policyname = 'deny_anon_chunks') THEN
    DROP POLICY "deny_anon_chunks" ON chunks;
  END IF;
  -- conversations
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'conversations' AND policyname = 'deny_anon_conversations') THEN
    DROP POLICY "deny_anon_conversations" ON conversations;
  END IF;
  -- messages
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'messages' AND policyname = 'deny_anon_messages') THEN
    DROP POLICY "deny_anon_messages" ON messages;
  END IF;
  -- devices
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'devices' AND policyname = 'deny_anon_devices') THEN
    DROP POLICY "deny_anon_devices" ON devices;
  END IF;
  -- invite_codes
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_codes' AND policyname = 'deny_anon_invite_codes') THEN
    DROP POLICY "deny_anon_invite_codes" ON invite_codes;
  END IF;
  -- infographics
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'infographics' AND policyname = 'deny_anon_infographics') THEN
    DROP POLICY "deny_anon_infographics" ON infographics;
  END IF;
END $$;

CREATE POLICY "deny_anon_sources" ON sources FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_chunks" ON chunks FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_conversations" ON conversations FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_messages" ON messages FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_devices" ON devices FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_invite_codes" ON invite_codes FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon_infographics" ON infographics FOR ALL TO anon USING (false);

-- 3. RPC-функция для атомарной регистрации устройств
CREATE OR REPLACE FUNCTION register_device_atomic(
  p_invite_code_id uuid,
  p_device_id text,
  p_device_limit int DEFAULT NULL,
  p_user_agent text DEFAULT ''
) RETURNS jsonb AS $$
DECLARE
  v_existing_id uuid;
  v_count int;
BEGIN
  SELECT id INTO v_existing_id FROM devices
  WHERE invite_code_id = p_invite_code_id AND device_id = p_device_id;

  IF v_existing_id IS NOT NULL THEN
    UPDATE devices SET last_seen_at = now(), user_agent = p_user_agent
    WHERE id = v_existing_id;
    RETURN jsonb_build_object('error', NULL, 'isNewDevice', false);
  END IF;

  IF p_device_limit IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM devices
    WHERE invite_code_id = p_invite_code_id;
    IF v_count >= p_device_limit THEN
      RETURN jsonb_build_object('error', 'Превышен лимит устройств', 'isNewDevice', false);
    END IF;
  END IF;

  INSERT INTO devices (invite_code_id, device_id, user_agent)
  VALUES (p_invite_code_id, p_device_id, p_user_agent);

  RETURN jsonb_build_object('error', NULL, 'isNewDevice', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
