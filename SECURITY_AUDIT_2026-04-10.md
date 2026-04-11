# Комплексный аудит безопасности (дополнение)

**Дата:** 2026-04-10  
**Репозиторий:** `snab-chat`  
**Формат:** code review + конфигурационный аудит + быстрый secret scan + проверка git history

---

## 1) Что было проверено

- Конфигурация HTTP-защиты и CORS (`helmet`, CSP, Origin checks, rate-limit).
- Публичные API-роуты и критичные mutation-эндпоинты.
- Защита от SSRF в `fetch-url`.
- Устойчивость к prompt-injection в RAG/chat цепочке.
- Риски утечки чувствительных данных (в коде и истории git).
- Базовая проверка зависимостей (`npm audit`) — с ограничением окружения.

---

## 2) Ключевые находки

## 🔴 Высокий риск

### H-01: SSRF-защита есть в Next API, но отсутствует в backend Express

- Без SSRF-валидации в `backend/src/routes/fetch-url.ts` можно использовать backend как прокси к внутренним адресам (metadata endpoints, RFC1918), если этот маршрут доступен извне.
- В Next-версии (`app/api/fetch-url/route.ts`) защита уже реализована (DNS/IP проверка, блок private ranges, ручная валидация redirect).

**Рекомендация:**  
Синхронизировать backend-реализацию с Next-версией: добавить private IP/DNS защиту + проверку редиректов на каждом hop.

---

### H-02: Слабая модель аутентификации админов (статический код в заголовке)

- `requireAdmin` проверяет только `x-admin-code` без сессии, срока жизни, nonce, подписи запроса или 2FA-токена на каждый запрос.
- На клиенте админ-код и invite-код хранятся в `localStorage` (при XSS это первая цель для кражи).

**Рекомендация:**  
Перейти на сессионную auth-схему:
1. одноразовый login (код + пароль/2FA),  
2. короткоживущий access token (HttpOnly + Secure + SameSite),  
3. refresh rotation,  
4. серверная инвалидация сессий.

---

## 🟠 Средний риск

### M-01: Блокировка direct POST по Origin/Referer может обходиться из-за `localhost` в middleware

- В `middleware.ts` функция `matchesHost` принимает `url.hostname === "localhost"` как валидный вариант.
- Для production это избыточное исключение и упрощает обход origin-гейта в ряде edge-кейсов/прокси-конфигураций.

**Рекомендация:**  
Разрешать `localhost` только при `NODE_ENV !== "production"` и/или по явному allowlist env.

---

### M-02: CSP содержит `'unsafe-inline'` для script-src

- Это ослабляет защиту от XSS и делает возможным выполнение inline script при наличии HTML injection.

**Рекомендация:**  
Переход на nonce/hash-based CSP:
- `script-src 'self' 'nonce-<dynamic>'`  
- убрать `'unsafe-inline'`.

---

### M-03: Остаточный риск prompt-injection (частичная фильтрация)

- В `app/api/chat/route.ts` применяется `sanitizeDocContent`, что снижает риск.
- Но regex-санитизация не является формальной гарантией; сложные обфусцированные инъекции и payload через естественный язык возможны.

**Рекомендация:**  
- Ввести policy-layer на уровне генерации ответа (allowlist типов утверждений, источник-обязательность).
- Добавить пост-валидацию ответа (например, reject если есть фразы-переопределения инструкций/неподтвержденные claims).
- Разделить контексты: «инструкции модели» и «не доверенные документы» на уровне tool execution policy.

---

## 🟡 Низкий риск / организационные

### L-01: В истории git обнаружены строки, похожие на ключи, но в формате примеров

- Найдены шаблонные значения вида `SUPABASE_SERVICE_ROLE_KEY=eyJ...` (документация/пример), без признаков полного рабочего ключа.
- Прямых hardcoded рабочих ключей в текущем дереве не обнаружено.

**Рекомендация:**  
- Подключить pre-commit и CI secret scanning (gitleaks/trufflehog) с fail policy.
- Проверить настройки репозитория на GitHub: Secret scanning + Push protection + Dependabot alerts.

---

## 3) Проверка открытых портов и поверхности атаки

- Backend явно слушает `0.0.0.0:${PORT}` (по умолчанию `3001`) и в Dockerfile делает `EXPOSE 3001`.
- Next.js приложение обслуживает API в рамках основного приложения (обычно 3000 локально / serverless в prod).

**Вывод:**  
Критично ограничить доступ к backend на сетевом уровне:
- allowlist ingress (только от frontend/proxy),
- запрет публичного доступа к внутренним admin/debug путям на WAF/reverse proxy,
- mTLS/IP allowlist для внутреннего backend (если архитектура позволяет).

---

## 4) Что сделать в первую очередь (план hardening)

### В течение 24 часов
1. Закрыть SSRF gap в `backend/src/routes/fetch-url.ts`.  
2. Убрать `localhost`-исключение из production Origin-check.  
3. Ограничить network ingress к backend (infra-level firewall/security groups).  
4. Включить автоматический secret scan в CI (push + PR).

### В течение 7 дней
1. Миграция с `x-admin-code` на токены с коротким TTL (HttpOnly cookies).  
2. CSP migration с nonce (убрать `unsafe-inline`).  
3. Централизованный audit-log для админ-действий + alerting.

### В течение 30 дней
1. Полноценная защита LLM-пайплайна от prompt injection (policy engine + response guardrails).  
2. Регулярный SAST/DAST pipeline (минимум weekly).  
3. Ротация всех секретов (Telegram, Supabase service role, Google API и др.) по регламенту.

---

## 5) Ограничения аудита

- `npm audit` не вернул advisories из-за ответа `403 Forbidden` от npm audit endpoint в текущем окружении.
- Аудит GitHub security center (Dependabot/CodeQL/Secret scanning alerts) невозможен без доступа к удаленному репозиторию/веб-интерфейсу.

