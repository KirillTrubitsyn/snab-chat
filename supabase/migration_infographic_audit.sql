-- Migration: Add admin_name and ip_address columns to infographics + conversations tables
-- Purpose: Fix security vulnerability — admin-created infographics/chats were untraceable ("Неизвестный"/"Админ")

DO $$
BEGIN
  -- Infographics: admin_name
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'infographics' AND column_name = 'admin_name'
  ) THEN
    ALTER TABLE infographics ADD COLUMN admin_name text DEFAULT NULL;
  END IF;

  -- Infographics: ip_address
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'infographics' AND column_name = 'ip_address'
  ) THEN
    ALTER TABLE infographics ADD COLUMN ip_address text DEFAULT NULL;
  END IF;

  -- Conversations: admin_name (для отображения ФИО админа в панели активности)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'admin_name'
  ) THEN
    ALTER TABLE conversations ADD COLUMN admin_name text DEFAULT NULL;
  END IF;
END $$;
