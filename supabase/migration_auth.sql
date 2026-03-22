-- ============================================================
-- СнабЧат — Миграция: система инвайт-кодов и привязка диалогов
-- Выполнить в Supabase SQL Editor ПОСЛЕ основной схемы (schema.sql)
-- ============================================================

-- 1. Таблица инвайт-кодов
create table if not exists invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,                    -- ФИО / кому выдан
  uses_remaining integer default null,   -- null = безлимит
  is_active boolean default true,
  created_at timestamptz default now()
);

create index if not exists invite_codes_code_idx on invite_codes (code);

-- 2. Привязка диалогов к инвайт-коду
alter table conversations
  add column if not exists invite_code_id uuid references invite_codes(id) on delete set null;

create index if not exists conversations_invite_code_id_idx on conversations (invite_code_id);
