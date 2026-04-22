-- ============================================================
-- Миграция: UNIQUE (filename, content_sha256) на sources
-- Цель (аудит C05 / L1-02 / L2-01): устранить дубликаты при повторной
--   загрузке идентичного файла. SHA-256 считается по парсированному
--   markdown (а не по исходному бинарнику), чтобы совпадение было
--   устойчиво к несущественным различиям тела PDF/DOCX.
--
-- Безопасность применения:
--   * Добавляет колонку `content_sha256 text NULL`. NULL не участвует в
--     UNIQUE-проверке (Postgres trаktует NULL как различные значения).
--     Существующие 44 дубля с NULL не сломают миграцию.
--   * Новый partial UNIQUE индекс применяется только к строкам, где
--     content_sha256 IS NOT NULL. Значит:
--       - новые ingest'ы (с sha256) защищены от дубликатов автоматически.
--       - старые дубли можно почистить отдельным админским скриптом.
--   * Идемпотентна: CREATE INDEX IF NOT EXISTS, ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- ============================================================

alter table sources
  add column if not exists content_sha256 text;

create unique index if not exists sources_filename_sha256_uniq_idx
  on sources (filename, content_sha256)
  where content_sha256 is not null;

comment on column sources.content_sha256 is
  'SHA-256 от парсированного markdown. Используется для UNIQUE(filename, content_sha256) — защита от повторной загрузки одного и того же документа. Заполняется в backend/src/routes/ingest.ts.';
