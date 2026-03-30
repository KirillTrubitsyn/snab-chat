-- ============================================================
-- Миграция: Улучшение FTS в hybrid_search
--
-- ПРОБЛЕМА: plainto_tsquery('russian', ...) не находит специфические
-- термины ("переторжка", "НМЦД", "ЗКО", "ЕИ") — русский стеммер
-- не распознаёт аббревиатуры и узкоспециальные слова.
-- В итоге 30% веса поиска (fts_weight=0.3) пропадает впустую.
--
-- РЕШЕНИЕ: Двойной FTS — русский стеммер + simple (без стемминга).
-- Берём максимальный score из двух, что гарантирует нахождение
-- как обычных слов (через стемминг), так и аббревиатур (через exact match).
--
-- Также добавляем fts_simple колонку для индексированного поиска
-- без стемминга.
--
-- Выполнить в Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- 1. Добавить колонку simple FTS (без стемминга, только lowercase)
alter table chunks add column if not exists fts_simple tsvector
  generated always as (to_tsvector('simple', content)) stored;

-- 2. Создать GIN-индекс для simple FTS
create index if not exists chunks_fts_simple_idx on chunks using gin (fts_simple);

-- 3. Обновить RPC-функцию hybrid_search с двойным FTS
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
  -- FTS с русским стеммером (находит словоформы: закупка/закупок/закупки)
  fts_russian as (
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
  -- FTS без стемминга (находит точные совпадения: НМЦД, ЗКО, переторжка)
  fts_simple as (
    select
      c.id::text as id,
      c.content,
      c.source_filename,
      c.chunk_index,
      c.tags,
      ts_rank_cd(c.fts_simple, plainto_tsquery('simple', query_text)) as fts_score
    from chunks c
    where c.fts_simple @@ plainto_tsquery('simple', query_text)
      and (filter_tags is null or c.tags && filter_tags)
    limit match_count * 2
  ),
  -- Объединяем оба FTS, берём максимальный score для каждого чанка
  fts_combined as (
    select
      coalesce(r.id, s.id) as id,
      coalesce(r.content, s.content) as content,
      coalesce(r.source_filename, s.source_filename) as source_filename,
      coalesce(r.chunk_index, s.chunk_index) as chunk_index,
      coalesce(r.tags, s.tags) as tags,
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
    combined.tags
  from combined
  order by combined.combined_score desc
  limit match_count;
end;
$$;
