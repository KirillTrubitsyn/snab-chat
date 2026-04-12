-- Migration: Add admin_name and ip_address columns to infographics table
-- Purpose: Fix security vulnerability — admin-created infographics were untraceable ("Неизвестный")

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'infographics' AND column_name = 'admin_name'
  ) THEN
    ALTER TABLE infographics ADD COLUMN admin_name text DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'infographics' AND column_name = 'ip_address'
  ) THEN
    ALTER TABLE infographics ADD COLUMN ip_address text DEFAULT NULL;
  END IF;
END $$;
