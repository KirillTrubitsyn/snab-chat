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
  tags text[]
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
      1 - (c.embedding <=> query_embedding) as vector_score
    from chunks c
    where (filter_tags is null or c.tags && filter_tags)
    order by c.embedding <=> query_embedding
    limit match_count * 2
  ),
  fts_results as (
    select
      c.id::text as id,
      c.content,
      c.source_filename,
      c.chunk_index,
      c.tags,
      ts_rank_cd(c.fts, plainto_tsquery('russian', query_text)) as fts_score
    from chunks c
    where c.fts @@ plainto_tsquery('russian', query_text)
      and (filter_tags is null or c.tags && filter_tags)
    limit match_count * 2
  ),
  combined as (
    select
      coalesce(v.id, f.id) as id,
      coalesce(v.content, f.content) as content,
      coalesce(v.source_filename, f.source_filename) as source_filename,
      coalesce(v.chunk_index, f.chunk_index) as chunk_index,
      coalesce(v.tags, f.tags) as tags,
      (
        coalesce(v.vector_score, 0) * vector_weight +
        coalesce(f.fts_score, 0) * fts_weight
      ) as combined_score
    from vector_results v
    full outer join fts_results f on v.id = f.id
  )
  select
    combined.id,
    combined.content,
    combined.source_filename,
    combined.chunk_index,
    combined.combined_score as similarity,
    combined.tags
  from combined
  order by combined.combined_score desc
  limit match_count;
end;
$$;

-- 9. RLS (Row Level Security) — отключено для service role
-- При необходимости включите RLS и настройте политики:
-- alter table sources enable row level security;
-- alter table chunks enable row level security;
-- alter table conversations enable row level security;
-- alter table messages enable row level security;
