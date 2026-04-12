# Финальный объединённый PR (apply all)

Этот документ объединяет все security-изменения в один итоговый набор для применения.

## Что войдёт в merge

### Кодовые изменения
- `app/api/chat/route.ts` — усиленная санитизация контента для LLM-контекста.
- `middleware.ts` — route-specific rate limits, stricter Origin/Referer проверка, защита auth/infographic.
- `app/api/eval-reranker/route.ts` — admin-only доступ.
- `app/api/migrate/route.ts` — `404` в production.
- `app/api/upload-url/route.ts` — MIME whitelist + безопасные ошибки.
- `app/api/sources/upload-original/route.ts` — file size limit + безопасные ошибки.
- `app/api/infographic/route.ts` — audit logging генераций.
- `app/lib/audit-log.ts` — action `infographic.generate`.

### Документация и артефакты
- `SECURITY_AUDIT.md` — консолидированный отчёт + повторные аудиты + инцидент по infographic bypass.
- `CLAUDE_SECURITY_AUDIT_PROMPT.md` — готовый промпт для аудита другого приложения.
- `UNIFIED_SECURITY_PR.md` — единое резюме и checklist.

## Что сделать после merge
1. Выполнить SQL: `supabase/migration_security_audit.sql`.
2. Добавить `DOWNLOAD_TOKEN_SECRET` в production env.
3. Включить edge WAF + bot protection.
4. Перевести rate-limit на Redis/Upstash.
5. Включить CI gates: secret scan + dependency scan + SAST/DAST.

## Почему это один итоговый PR
- Закрывает найденные кодовые уязвимости.
- Добавляет наблюдаемость инцидентов (audit trail).
- Оставляет только инфраструктурные/процессные шаги вне кода.
