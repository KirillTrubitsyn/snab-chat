# Единый итоговый PR по безопасности (готов к merge)

Дата: 2026-04-11

## Что вошло в итог

### 1) Защита LLM-контекста и prompt-инъекций
- Усилена `sanitizeDocContent()` в `app/api/chat/route.ts`:
  - фильтрация опасных паттернов,
  - удаление управляющих символов,
  - XML-escaping (`&`, `<`, `>`), чтобы исключить разрыв `<documents>/<document>` структуры.

### 2) Закрытие открытых/диагностических поверхностей
- `GET /api/eval-reranker` переведён под `requireAdmin`.
- Для `/api/eval-reranker` добавлен отдельный жёсткий rate-limit.
- `POST /api/migrate` отключён в production (`404`).

### 3) Усиление auth-контура
- Добавлены route-specific лимиты для:
  - `/api/auth/login-password`
  - `/api/auth/verify-password`
  - `/api/auth/verify-otp`
  - `/api/auth/verify-setup-otp`
  - `/api/auth/send-otp`
  - `/api/auth/setup-totp`
- Origin/Referer-защита распространена на префикс `/api/auth`.

### 4) Усиление upload-поверхности и утечек ошибок
- `/api/upload-url`:
  - MIME whitelist,
  - отказ для неподдерживаемых MIME.
- `/api/sources/upload-original`:
  - лимит размера,
  - обезличенные server errors вместо деталей DB/Storage.

### 5) Повторные аудиты и документация
- `SECURITY_AUDIT.md` объединён и дополнен:
  - единый merged-блок,
  - повторный аудит (2026-04-11),
  - остаточные инфраструктурные задачи: WAF, DAST, ротация ключей, distributed rate limit.

## Что осталось вне кода (инфраструктура)
- P0: Cloudflare WAF + bot protection, Redis/Upstash rate-limit, CI secret/dependency gates.
- P2: регулярный DAST (ZAP/Nuclei) и ключевая ротация по реестру.

## Merge-checklist
- [ ] Применить `supabase/migration_security_audit.sql` в Supabase
- [ ] Задать `DOWNLOAD_TOKEN_SECRET` в production env
- [ ] Проверить WAF правила и rate-limit policy на edge
- [ ] Включить CI secret scanning (gitleaks) и dependency scanning
