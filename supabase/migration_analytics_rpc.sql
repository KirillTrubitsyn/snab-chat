-- ============================================================
-- Аналитика админ-панели: per-request трекинг платформы + RPC-агрегации.
--
-- Применять ВРУЧНУЮ в Supabase SQL Editor (как сиды инвайт-кодов).
-- Безопасно при повторном запуске: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE.
--
-- Определение «запроса» (взаимоисключающие типы, чтобы donut/итоги не двоились):
--   chat        — пользовательское сообщение БЕЗ вложений
--   document    — пользовательское сообщение С вложениями (1 запрос = 1 сообщение)
--   infographic — генерация инфографики
-- Итого «всего запросов» = (пользовательские сообщения) + (инфографики).
-- Организация/имя резолвятся по семантике resolveUser (backend/src/routes/admin.ts):
--   invite_code_id → invite_codes.{organization,name}; иначе админ → 'Админ'.
-- ============================================================

-- 1. Колонки платформы (NULL = неизвестно/легаси; бэкенд сворачивает NULL в «Десктоп»).
ALTER TABLE messages    ADD COLUMN IF NOT EXISTS is_mobile boolean DEFAULT NULL;
ALTER TABLE infographics ADD COLUMN IF NOT EXISTS is_mobile boolean DEFAULT NULL;

-- 2. Базовая функция: единый набор «запросов» за период с резолвом организации/пользователя.
CREATE OR REPLACE FUNCTION public.analytics_requests(
  p_from timestamptz,
  p_to   timestamptz,
  p_org  text DEFAULT NULL
)
RETURNS TABLE(created_at timestamptz, req_type text, organization text, user_name text, is_mobile boolean)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  -- chat: пользовательские сообщения без вложений
  SELECT
    m.created_at,
    'chat'::text AS req_type,
    COALESCE(ic.organization, CASE WHEN c.invite_code_id IS NULL THEN 'Админ' END) AS organization,
    COALESCE(ic.name, CASE WHEN c.invite_code_id IS NULL THEN 'Админ' END, 'Неизвестный') AS user_name,
    m.is_mobile
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN invite_codes ic ON ic.id = c.invite_code_id
  WHERE m.role = 'user'
    AND m.created_at >= p_from AND m.created_at < p_to
    AND (
      m.metadata -> 'attached_files' IS NULL
      OR jsonb_typeof(m.metadata -> 'attached_files') <> 'array'
      OR jsonb_array_length(m.metadata -> 'attached_files') = 0
    )
    AND (p_org IS NULL OR COALESCE(ic.organization, CASE WHEN c.invite_code_id IS NULL THEN 'Админ' END) = p_org)

  UNION ALL

  -- document: пользовательские сообщения с вложениями (1 запрос = 1 сообщение)
  SELECT
    m.created_at,
    'document'::text,
    COALESCE(ic.organization, CASE WHEN c.invite_code_id IS NULL THEN 'Админ' END),
    COALESCE(ic.name, CASE WHEN c.invite_code_id IS NULL THEN 'Админ' END, 'Неизвестный'),
    m.is_mobile
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN invite_codes ic ON ic.id = c.invite_code_id
  WHERE m.role = 'user'
    AND m.created_at >= p_from AND m.created_at < p_to
    AND jsonb_typeof(m.metadata -> 'attached_files') = 'array'
    AND jsonb_array_length(m.metadata -> 'attached_files') > 0
    AND (p_org IS NULL OR COALESCE(ic.organization, CASE WHEN c.invite_code_id IS NULL THEN 'Админ' END) = p_org)

  UNION ALL

  -- infographic
  SELECT
    ig.created_at,
    'infographic'::text,
    COALESCE(ic.organization, CASE WHEN ig.invite_code_id IS NULL THEN 'Админ' END),
    COALESCE(ic.name, ig.admin_name, CASE WHEN ig.invite_code_id IS NULL THEN 'Админ' END, 'Неизвестный'),
    ig.is_mobile
  FROM infographics ig
  LEFT JOIN invite_codes ic ON ic.id = ig.invite_code_id
  WHERE ig.created_at >= p_from AND ig.created_at < p_to
    AND (p_org IS NULL OR COALESCE(ic.organization, CASE WHEN ig.invite_code_id IS NULL THEN 'Админ' END) = p_org);
$$;

-- 3. Активность во времени (одна строка на бакет+тип).
CREATE OR REPLACE FUNCTION public.analytics_activity_over_time(
  p_from   timestamptz,
  p_to     timestamptz,
  p_org    text DEFAULT NULL,
  p_bucket text DEFAULT 'day'
)
RETURNS TABLE(bucket date, req_type text, cnt bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT date_trunc(p_bucket, created_at)::date AS bucket, req_type, count(*)::bigint
  FROM public.analytics_requests(p_from, p_to, p_org)
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

-- 4. Разбивка по типам запросов.
CREATE OR REPLACE FUNCTION public.analytics_type_breakdown(
  p_from timestamptz,
  p_to   timestamptz,
  p_org  text DEFAULT NULL
)
RETURNS TABLE(req_type text, cnt bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT req_type, count(*)::bigint
  FROM public.analytics_requests(p_from, p_to, p_org)
  GROUP BY 1
  ORDER BY 2 DESC;
$$;

-- 5. Самые активные пользователи.
CREATE OR REPLACE FUNCTION public.analytics_top_users(
  p_from  timestamptz,
  p_to    timestamptz,
  p_org   text DEFAULT NULL,
  p_limit int DEFAULT 10
)
RETURNS TABLE(user_name text, organization text, cnt bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT user_name, organization, count(*)::bigint
  FROM public.analytics_requests(p_from, p_to, p_org)
  GROUP BY 1, 2
  ORDER BY 3 DESC
  LIMIT p_limit;
$$;

-- 6. Разбивка по организациям (без org-фильтра).
CREATE OR REPLACE FUNCTION public.analytics_by_org(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE(organization text, cnt bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE(organization, '—') AS organization, count(*)::bigint
  FROM public.analytics_requests(p_from, p_to, NULL)
  GROUP BY 1
  ORDER BY 2 DESC;
$$;

-- 7. Мобильный/десктоп (NULL = неизвестно; бэкенд сворачивает в «Десктоп»).
CREATE OR REPLACE FUNCTION public.analytics_platform_split(
  p_from timestamptz,
  p_to   timestamptz,
  p_org  text DEFAULT NULL
)
RETURNS TABLE(is_mobile boolean, cnt bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT is_mobile, count(*)::bigint
  FROM public.analytics_requests(p_from, p_to, p_org)
  GROUP BY 1;
$$;

-- 8. KPI-сводка за период.
CREATE OR REPLACE FUNCTION public.analytics_kpis(
  p_from timestamptz,
  p_to   timestamptz,
  p_org  text DEFAULT NULL
)
RETURNS TABLE(
  total_requests  bigint,
  unique_users    bigint,
  org_count       bigint,
  chat_cnt        bigint,
  infographic_cnt bigint,
  document_cnt    bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT
    count(*)::bigint,
    count(DISTINCT user_name)::bigint,
    count(DISTINCT organization)::bigint,
    (count(*) FILTER (WHERE req_type = 'chat'))::bigint,
    (count(*) FILTER (WHERE req_type = 'infographic'))::bigint,
    (count(*) FILTER (WHERE req_type = 'document'))::bigint
  FROM public.analytics_requests(p_from, p_to, p_org);
$$;

-- 9. Доступ: только service_role (бэкенд за requireAdmin). Закрываем PostgREST для anon/authenticated.
REVOKE ALL ON FUNCTION public.analytics_requests(timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_activity_over_time(timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_type_breakdown(timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_top_users(timestamptz, timestamptz, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_by_org(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_platform_split(timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_kpis(timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
