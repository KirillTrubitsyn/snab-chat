-- ============================================================
-- СнабЧат — полная схема базы данных Supabase
-- Выполнить в Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- 1. Расширения
create extension if not exists vector with schema extensions;

-- 2. Таблица источников (загруженные документы)
create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  mime_type text not null,
  tags text[] default '{}',
  content_preview text default '',
  storage_path text,
  folder_path text,
  created_at timestamptz default now()
);

-- 2b. Supabase Storage bucket для оригинальных файлов
-- Создайте bucket "documents" в Supabase Dashboard → Storage → New bucket
-- Или выполните:
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- 3. Таблица чанков (фрагменты документов с эмбеддингами)
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources(id) on delete cascade,
  source_filename text not null,
  chunk_index integer not null,
  content text not null,
  embedding vector(1536),
  tags text[] default '{}',
  created_at timestamptz default now()
);

-- 4. Индексы для поиска
-- Векторный индекс (IVFFlat для быстрого similarity search)
create index if not exists chunks_embedding_idx
  on chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Полнотекстовый индекс (GIN для FTS)
alter table chunks add column if not exists fts tsvector
  generated always as (to_tsvector('russian', content)) stored;

create index if not exists chunks_fts_idx on chunks using gin (fts);

-- Полнотекстовый индекс без стемминга (для аббревиатур: НМЦД, ЗКО, ЕИ)
alter table chunks add column if not exists fts_simple tsvector
  generated always as (to_tsvector('simple', content)) stored;

create index if not exists chunks_fts_simple_idx on chunks using gin (fts_simple);

-- Индекс по source_id для каскадных операций
create index if not exists chunks_source_id_idx on chunks (source_id);

-- Индекс по тегам
create index if not exists chunks_tags_idx on chunks using gin (tags);

-- 5. Таблица инвайт-кодов
create table if not exists invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,                    -- ФИО / кому выдан
  organization text default null,        -- Организация
  uses_remaining integer default null,   -- null = безлимит (устаревшее, для совместимости)
  chat_limit integer default null,       -- лимит запросов в чат (null = безлимит)
  infographic_limit integer default null, -- лимит генераций инфографики (null = безлимит)
  device_limit integer default 2,        -- лимит устройств (null = безлимит, по умолчанию 2)
  is_active boolean default true,
  created_at timestamptz default now()
);

create index if not exists invite_codes_code_idx on invite_codes (code);

-- 5b. Таблица устройств (привязка устройств к инвайт-кодам)
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid not null references invite_codes(id) on delete cascade,
  device_id text not null,
  user_agent text default '',
  last_seen_at timestamptz default now(),
  created_at timestamptz default now(),
  unique(invite_code_id, device_id)
);

create index if not exists devices_invite_code_id_idx on devices (invite_code_id);

-- 6. Таблица диалогов
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  title text default 'Новый диалог',
  summary text,
  invite_code_id uuid references invite_codes(id) on delete set null,
  admin_name text,  -- ФИО админа (заполняется только для админских диалогов)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists conversations_invite_code_id_idx on conversations (invite_code_id);

-- 7. Таблица сообщений
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  token_estimate integer default 0,
  metadata jsonb default null,
  created_at timestamptz default now()
);

-- Миграция (для существующей БД):
-- ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata jsonb default null;

create index if not exists messages_conversation_id_idx
  on messages (conversation_id, created_at);

-- 8. RPC-функция гибридного поиска (vector + FTS)
create or replace function hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_count integer default 20,
  vector_weight float default 0.7,
  fts_weight float default 0.3,
  filter_tags text[] default null
)
returns table (
  id text,
  content text,
  source_filename text,
  chunk_index integer,
  similarity float,
  tags text[],
  image_paths text[]
)
language plpgsql
as $$
begin
  return query
  with vector_results as (
    select
      c.id::text as id,
      c.content,
      c.source_filename,
      c.chunk_index,
      c.tags,
      c.image_paths,
      1 - (c.embedding <=> query_embedding) as vector_score
    from chunks c
    where (filter_tags is null or c.tags && filter_tags)
    order by c.embedding <=> query_embedding
    limit match_count * 2
  ),
  fts_russian as (
    select
      c.id::text as id,
      c.content,
      c.source_filename,
      c.chunk_index,
      c.tags,
      c.image_paths,
      ts_rank_cd(c.fts, plainto_tsquery('russian', query_text)) as fts_score
    from chunks c
    where c.fts @@ plainto_tsquery('russian', query_text)
      and (filter_tags is null or c.tags && filter_tags)
    limit match_count * 2
  ),
  fts_simple as (
    select
      c.id::text as id,
      c.content,
      c.source_filename,
      c.chunk_index,
      c.tags,
      c.image_paths,
      ts_rank_cd(c.fts_simple, plainto_tsquery('simple', query_text)) as fts_score
    from chunks c
    where c.fts_simple @@ plainto_tsquery('simple', query_text)
      and (filter_tags is null or c.tags && filter_tags)
    limit match_count * 2
  ),
  fts_combined as (
    select
      coalesce(r.id, s.id) as id,
      coalesce(r.content, s.content) as content,
      coalesce(r.source_filename, s.source_filename) as source_filename,
      coalesce(r.chunk_index, s.chunk_index) as chunk_index,
      coalesce(r.tags, s.tags) as tags,
      coalesce(r.image_paths, s.image_paths) as image_paths,
      greatest(coalesce(r.fts_score, 0), coalesce(s.fts_score, 0)) as fts_score
    from fts_russian r
    full outer join fts_simple s on r.id = s.id
  ),
  combined as (
    select
      coalesce(v.id, f.id) as id,
      coalesce(v.content, f.content) as content,
      coalesce(v.source_filename, f.source_filename) as source_filename,
      coalesce(v.chunk_index, f.chunk_index) as chunk_index,
      coalesce(v.tags, f.tags) as tags,
      coalesce(v.image_paths, f.image_paths) as image_paths,
      (
        coalesce(v.vector_score, 0) * vector_weight +
        coalesce(f.fts_score, 0) * fts_weight
      ) as combined_score
    from vector_results v
    full outer join fts_combined f on v.id = f.id
  )
  select
    combined.id,
    combined.content,
    combined.source_filename,
    combined.chunk_index,
    combined.combined_score as similarity,
    combined.tags,
    combined.image_paths
  from combined
  order by combined.combined_score desc
  limit match_count;
end;
$$;

-- 9. Таблица нецелевых запросов (LLM-классифицированные)
create table if not exists off_topic_queries (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid references invite_codes(id) on delete set null,
  user_name text not null,
  organization text,
  category text not null,
  query_text text not null,
  created_at timestamptz default now()
);

create index if not exists idx_off_topic_created on off_topic_queries(created_at desc);
create index if not exists idx_off_topic_category on off_topic_queries(category);

-- 10. Таблица обращений в поддержку
create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid references invite_codes(id) on delete set null,
  user_name text not null,
  organization text,
  message text not null,
  admin_reply text,
  admin_number int,
  status text default 'open' check (status in ('open', 'answered', 'closed')),
  created_at timestamptz default now(),
  replied_at timestamptz
);

create index if not exists idx_support_created on support_messages(created_at desc);
create index if not exists idx_support_status on support_messages(status);

-- 11. Таблица логов ошибок
create table if not exists error_logs (
  id uuid primary key default gen_random_uuid(),
  error_type text not null,
  error_message text not null,
  endpoint text,
  user_name text,
  organization text,
  invite_code_id uuid references invite_codes(id) on delete set null,
  metadata jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_errors_created on error_logs(created_at desc);
create index if not exists idx_errors_type on error_logs(error_type);

-- 12. Аудит-лог админских действий
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  admin_name text not null,
  target_id text,
  details jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_audit_created on audit_log(created_at desc);
create index if not exists idx_audit_admin on audit_log(admin_name);
create index if not exists idx_audit_action on audit_log(action);

-- 13. Таблица инфографик (отдельное хранилище, не привязано к сообщениям)
create table if not exists infographics (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid references invite_codes(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  topic text not null default '',
  style text not null default 'business_infographic',
  aspect_ratio text not null default '16:9',
  description text default '',
  image_base64 text not null,
  created_at timestamptz default now()
);

create index if not exists idx_infographics_invite on infographics(invite_code_id);
create index if not exists idx_infographics_created on infographics(created_at desc);

-- 14. RLS (Row Level Security) — отключено для service role
-- При необходимости включите RLS и настройте политики:
-- alter table sources enable row level security;
-- alter table chunks enable row level security;
-- alter table conversations enable row level security;
-- alter table messages enable row level security;

-- ============================================================
-- МИГРАЦИЯ: Пароли + 2FA (выполнить в Supabase SQL Editor)
-- ============================================================
ALTER TABLE invite_codes
  ADD COLUMN IF NOT EXISTS password_hash    text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS telegram_chat_id text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS phone_number     text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS otp_code         text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS otp_expires_at   timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS totp_secret      text DEFAULT NULL;
