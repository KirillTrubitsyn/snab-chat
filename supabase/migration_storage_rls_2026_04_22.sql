-- =============================================================
-- Миграция: RLS на Supabase Storage buckets (L7-01, 2026-04-22)
--
-- Что закрываем:
--   Supabase Security Advisor: отсутствие явных RLS-политик на
--   storage.objects для приватных bucket'ов. Формально `public=false`
--   на bucket уже блокирует анонимную загрузку без signed URL, но без
--   явной policy приоритет поведения определяется дефолтами Supabase
--   Storage и может измениться при апгрейде. Явные RESTRICTIVE-policy
--   делают модель явной и устойчивой к регрессии.
--
-- Состояние bucket'ов (на момент миграции):
--   - documents    (public=false) — приватный, доступ только service-role
--   - chunk-images (public=false) — приватный, доступ только service-role
--   - chat-uploads (public=false) — приватный, доступ только service-role
--   - videos       (public=true)  — публичный, обучающие ролики,
--                                    остаётся доступным для SELECT anon
--
-- Важно:
--   - service_role ОБХОДИТ RLS по умолчанию в Supabase Storage, поэтому
--     backend-операции (ingest, upload, chat, admin) не ломаются.
--   - RESTRICTIVE-policy по правилам Postgres накладывается поверх
--     всех PERMISSIVE: чтобы запрос прошёл, он должен пройти И хотя бы
--     одну PERMISSIVE, И ВСЕ RESTRICTIVE. Поэтому USING (bucket_id NOT
--     IN ('documents', ...)) эффективно запрещает доступ к приватным
--     bucket'ам даже если кто-то в будущем добавит широкую PERMISSIVE.
--
-- Выполнить в Supabase SQL Editor ОДИН РАЗ.
-- =============================================================

-- RLS на storage.objects включается Supabase-ом по умолчанию;
-- ALTER идемпотентен — просто гарантирует состояние.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- ── 1. Универсальный RESTRICTIVE запрет для anon/authenticated ──
-- на приватные bucket'ы: documents, chunk-images, chat-uploads.
--
-- RESTRICTIVE-policy накладывается поверх PERMISSIVE и требует, чтобы
-- запись НЕ относилась к приватному bucket'у. Service-role обходит
-- RLS целиком и не затрагивается.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'storage'
               AND tablename = 'objects'
               AND policyname = 'restrict_anon_private_buckets')
  THEN DROP POLICY "restrict_anon_private_buckets" ON storage.objects; END IF;
END $$;
CREATE POLICY "restrict_anon_private_buckets"
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL TO anon
  USING (bucket_id NOT IN ('documents', 'chunk-images', 'chat-uploads'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'storage'
               AND tablename = 'objects'
               AND policyname = 'restrict_authenticated_private_buckets')
  THEN DROP POLICY "restrict_authenticated_private_buckets" ON storage.objects; END IF;
END $$;
CREATE POLICY "restrict_authenticated_private_buckets"
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (bucket_id NOT IN ('documents', 'chunk-images', 'chat-uploads'));

-- ── 2. PERMISSIVE разрешение anon читать публичный videos-bucket ──
-- Нужна явная policy: RLS без policy означает deny для не-service ролей.
-- Для обучающих видеороликов оставляем SELECT открытым, запись
-- по-прежнему только service-role.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'storage'
               AND tablename = 'objects'
               AND policyname = 'allow_anon_read_videos')
  THEN DROP POLICY "allow_anon_read_videos" ON storage.objects; END IF;
END $$;
CREATE POLICY "allow_anon_read_videos"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'videos');

-- ── 3. Проверка ───────────────────────────────────────────────
-- После применения этот запрос должен вернуть 3 policy:
--   SELECT policyname, roles, cmd, permissive
--   FROM pg_policies
--   WHERE schemaname='storage' AND tablename='objects'
--   ORDER BY policyname;
--
-- Ожидается:
--   allow_anon_read_videos                    | {anon}          | SELECT | PERMISSIVE
--   restrict_anon_private_buckets             | {anon}          | ALL    | RESTRICTIVE
--   restrict_authenticated_private_buckets    | {authenticated} | ALL    | RESTRICTIVE
--
-- Smoke-тесты (через anon-ключ, должны возвращать 0 или 403):
--   - GET  /storage/v1/object/documents/…    → 403
--   - POST /storage/v1/object/chunk-images/… → 403
--   - GET  /storage/v1/object/videos/…       → 200 (если файл публичный)
--
-- Если что-то в приложении начнёт 403-ить — значит этот путь ходит
-- не через service-role client. Проверить backend/src/lib/supabase.ts
-- (createServiceClient) и убедиться, что не используется anon-client.
