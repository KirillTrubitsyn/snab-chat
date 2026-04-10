# Комплексный аудит безопасности SnabChat

**Дата аудита:** 2026-04-10  
**Формат:** статический аудит кода + проверка истории Git + проверка зависимостей (где доступно)

## Что проверено

1. Поверхность API (Next.js `app/api/*` и Express backend `backend/src/routes/*`).
2. Наличие явной авторизации/ограничения доступа на критичных маршрутах.
3. Наличие защит от prompt injection в RAG/LLM контуре.
4. Риски утечки секретов в коде и в истории Git.
5. Базовые инфраструктурные настройки: CORS, security headers, rate limiting, exposed ports.

---

## Ключевые выводы

### 1) Открытые/слабо защищённые эндпоинты

#### [HIGH] Публичный диагностический endpoint `/api/eval-reranker`
- Маршрут выполняет серию дорогих поисковых и rerank-операций, потенциально с внешними API провайдерами, но в текущем файле нет проверки `requireAdmin`/`requireAuth`.
- Это создаёт риск:
  - эксплуатационного DoS (дорогие вызовы можно триггерить извне),
  - непреднамеренной утечки метаданных по качеству/документам.
- Файл: `app/api/eval-reranker/route.ts`.

**Рекомендация:** закрыть endpoint под `requireAdmin` и/или полностью отключать в `NODE_ENV=production`.

#### [HIGH] Токены/коды в query-параметрах для download-like маршрутов
- Маршруты поддерживают `?token=` и принимают там invite/admin код.
- Это риск утечки через:
  - access-логи reverse-proxy,
  - browser history,
  - Referer (частично снижен, но не гарантирован для всех цепочек).
- Файлы: `app/api/sources/download/route.ts`, `app/api/sources/signed-url/route.ts`.

**Рекомендация:** перейти на HMAC/JWT short-lived download token (как уже сделано для `/api/chunk-image`) и убрать raw-коды из URL.

#### [MEDIUM] Telegram webhook исключён из middleware rate-limit
- В `middleware.ts` вебхук Telegram пропускается без лимитов.
- При корректном секрете это допустимо, но остаётся поверхность для flood-нагрузки (особенно если секрет компрометирован).

**Рекомендация:** добавить отдельный мягкий rate-limit для webhook по IP + monitor/alert на аномалии.

---

### 2) Устойчивость к prompt injection

#### [MEDIUM, partially mitigated]
- В `app/api/chat/route.ts` есть явная текстовая политика игнорирования инъекций и санитизация `sanitizeDocContent()`.
- Это хороший слой защиты, но regex-санитизация не даёт 100% гарантии против непрямых/семантических инъекций.

**Рекомендации:**
1. Добавить структурную изоляцию контекста (tool/function calling + строгая schema-first выдача).
2. Ввести детектор инъекций как отдельный классификатор до финального промпта.
3. Логировать срабатывания паттернов инъекций и алертить при всплесках.

---

### 3) Проверка секретов в коде и Git-истории

#### [LOW / INFO]
- В рабочем дереве не найдены явные живые ключи по базовым сигнатурам (AWS/Google/OpenAI/Private Key и пр.).
- Найдены только примеры/шаблоны в `.env.example` и документации (`CLAUDE.md`), включая маски вида `eyJ...`, `AIza...`.
- В git history quick-scan также обнаружены только шаблонные/маскированные значения.

**Рекомендации:**
1. Подключить pre-commit/pre-receive secret scanning (gitleaks/trufflehog).
2. Включить GitHub Secret Scanning + Push Protection.
3. Ротировать все прод-ключи по расписанию (минимум раз в 90 дней) и сразу после любого инцидента.

---

### 4) Порты и инфраструктурная поверхность

#### [INFO]
- Backend слушает `0.0.0.0:3001` и Dockerfile делает `EXPOSE 3001` — это стандартно для контейнера, но внешний доступ должен быть ограничен ingress/firewall.
- CORS ограничен списком `FRONTEND_URL` с явной валидацией origin.
- `helmet()` и CSP/security headers включены.

#### [MEDIUM]
- CSP содержит `'unsafe-inline'` для script/style, что ослабляет XSS-защиту.

**Рекомендация:** миграция на nonce/hash-based CSP без `unsafe-inline`.

---

## Приоритетный план усиления (практичный)

### P0 (сделать в первую очередь, 24–48 часов)
1. Закрыть `/api/eval-reranker` (admin-only или off in production).
2. Убрать raw invite/admin коды из query params на download endpoints.
3. Включить автоматический secret scanning в CI + push protection.

### P1 (1 неделя)
1. Вынести rate limiting в Redis/Upstash (сейчас in-memory per-instance).
2. Добавить отдельный throttling/abuse-detection для webhook маршрутов.
3. Усилить аудит-логирование (кто/когда/какой документ скачивал, с какого IP/UA).

### P2 (2–4 недели)
1. Перейти на strict CSP (nonce/hashes).
2. Ввести отдельный pipeline prompt-injection detection + quarantine режим.
3. Провести внешний pentest (API + auth flows + file upload).

---

## Чеклист «максимально защититься»

- [ ] Все админ/диагностические endpoint'ы закрыты авторизацией.
- [ ] Нет секретов в URL, только короткоживущие подписанные токены.
- [ ] Включён secret scanning (локально + CI + GitHub).
- [ ] Centralized rate limit (Redis) + защита от burst/flood.
- [ ] CSP без unsafe-inline.
- [ ] Регулярная ротация ключей и инвентаризация секретов.
- [ ] Непрерывный мониторинг 401/403/429/5xx и аномалий по endpoint'ам.

