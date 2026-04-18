# API-поверхность

## Что проверять

### 1. Инвентаризация эндпоинтов

Найди все API route handlers в проекте и составь полную карту. Для каждого зафиксируй: HTTP-метод, путь, уровень защиты (public / auth / admin), наличие валидации входных данных, наличие ownership check.

Где искать маршруты:
- **Next.js**: `app/api/**/route.ts`, `pages/api/**/*.ts`, Server Actions в `app/**/actions.ts`
- **Express**: `app.get/post/put/delete/patch()`, `router.get()` и т. д.
- **Fastify**: `fastify.route()`, `fastify.get()` и т. д.
- **Django**: `urlpatterns`, `@api_view`, ViewSet'ы
- **FastAPI**: `@app.get()`, `@router.post()` и т. д.
- **Rails**: `config/routes.rb`, `resources`, `namespace`
- **GraphQL**: resolvers, queries, mutations — каждый эквивалентен REST-эндпоинту

### 2. BOLA — приоритетная проверка №1

**Broken Object Level Authorization (API1 OWASP API Security Top 10, фигурирует в 40–62% API breach-инцидентов 2026)**. Это наиболее частая и наиболее эксплуатируемая категория уязвимостей в API: 73% взломов начинаются через API, 97% из них — одним HTTP-запросом.

Для каждого эндпоинта, который читает, модифицирует или удаляет объект по ID:

- Где берётся ID объекта: из URL, из query, из body?
- Где берётся user context: из JWT/session, или (ошибка) из body/header?
- Применяется ли проверка ownership: `WHERE user_id = current_user.id` в запросе или эквивалент?
- Проверка должна быть **server-side**, не на фронтенде.
- Тест: авторизоваться как user A, попытаться запросить объект user B по ID — должна быть ошибка 403 или 404 (консистентно, иначе enumeration).
- **BOPLA (Broken Object Property Level Authorization)**: может ли пользователь изменить поле, которое не должен (например, `{role: "admin"}` в user update)? Включи whitelist редактируемых полей, mass assignment в `create`/`update` (см. раздел 4).

Paттерны, которые подозрительны и требуют ручной проверки:
- `WHERE id = $1` без `AND user_id = $2`
- `findById(id)` без дополнительного scope
- `params.id` передаётся напрямую в ORM-вызов
- Public IDs = autoincrement integer (позволяет enumeration; используй UUID).

### 3. Открытые эндпоинты без защиты

Для каждого эндпоинта без auth middleware определи: это допустимо (health check, публичная страница) или дыра?

Опасные паттерны:
- Любой мутирующий эндпоинт (POST/PUT/DELETE/PATCH) без auth.
- Эндпоинты, возвращающие пользовательские данные без auth.
- Admin-эндпоинты, доступные без проверки роли (vertical privilege escalation).
- Internal-эндпоинты (debug, metrics, admin-API) экспонированные на public network.

### 4. Валидация входных данных и Mass Assignment

- Есть ли schema validation (zod, joi, yup, pydantic, marshmallow, dry-validation)?
- Проверяются ли типы, длины, допустимые значения (whitelist vs blacklist)?
- **Mass assignment**: принимает ли эндпоинт произвольные поля из body и передаёт их в update/create? Ищи `req.body` напрямую в ORM-вызовах без фильтрации полей. Защита: явный whitelist редактируемых полей через schema или `Object.pick()`.
- Injection через сложные типы: NoSQL operator injection (`{$ne: null}`, `{$gt: ""}`, `{$where: ...}`), LDAP injection, XXE в XML.

### 5. Rate limiting и anti-bruteforce

- Есть ли rate limiter (express-rate-limit, slowapi, rack-attack, встроенный в Next.js, Vercel WAF, Cloudflare)?
- Как определяется IP клиента: доверяет ли `X-Forwarded-For` без валидации? За прокси/CDN это позволяет подставить произвольный IP.
- Где хранится состояние rate limiter: в памяти процесса (не работает при горизонтальном масштабировании) или в Redis/внешнем хранилище?
- Есть ли отдельный, более строгий рейт-лимит на login/register/password-reset/2FA-code?
- Для AI-приложений: per-user token limit (см. `llm-security.md` LLM10).

### 6. Обработка ошибок и Mishandling of Exceptional Conditions

**Новая категория OWASP A10:2025 Mishandling of Exceptional Conditions**. Программы, не корректно обрабатывающие исключительные состояния (таймауты, out-of-memory, corruption, invariant violations), могут падать в небезопасное состояние.

- Возвращаются ли stack traces в production-ответах? Ищи: `NODE_ENV !== 'production'`, `DEBUG = True`, отсутствие error handler middleware.
- Утекают ли имена таблиц, SQL-запросы, внутренние пути в сообщениях об ошибках (CWE-209)?
- Ищи `catch` блоки, которые пробрасывают ошибку напрямую: `res.json({ error: err.message })` или `return Response.json(error)`.
- **Fail-open vs fail-closed**: когда auth-проверка или proxy-check бросает исключение — что делает код? Fail-open (разрешает доступ) — критическая ошибка. Безопасный паттерн: fail-closed, deny by default.
- NULL dereference / unchecked return values (CWE-476): может ли исключение в боковой ветке привести к панике / crash / повторному запросу, обходящему проверку?
- Uncaught exceptions в background jobs / async handlers: не приводят ли они к silent failure критичных операций (например, audit log не пишется, но основная операция проходит)?
- Timeout и resource exhaustion: есть ли circuit breakers, backpressure?

### 7. SSRF (в OWASP 2025 поглощён в A01 Broken Access Control)

Если бэкенд делает HTTP-запросы по URL, полученному от пользователя (загрузка изображения по ссылке, preview URL, webhook URL, proxy, LLM-tool), проверь:

- Блокируются ли приватные IP-диапазоны: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fd00::/8`?
- Блокируется ли доступ к metadata-эндпоинтам облачных провайдеров: `169.254.169.254` (AWS/GCP/Azure IMDS), `100.100.100.200` (Alibaba), `metadata.google.internal`?
- DNS rebinding: проверяется ли resolved IP после DNS-резолва, а не только hostname? Идеально — резолвить один раз и использовать `resolve + connect-to-IP`.
- Ограничены ли протоколы (`http://`, `https://` only)? Блокируются ли `file://`, `gopher://`, `dict://`, `ftp://`?
- Webhook-интеграции: валидируется ли URL при регистрации webhook? Может ли атакующий зарегистрировать webhook на внутренний сервис?
- Redirect following: если HTTP-клиент следует за redirect — проверяется ли target каждого redirect против того же whitelist?

### 8. Криптография (OWASP A04:2025 Cryptographic Failures)

- Алгоритм хеширования паролей: bcrypt / argon2 / scrypt (безопасные) vs md5 / sha1 / sha256 без salt (уязвимые).
- Генерация случайных значений: `crypto.randomBytes` / `secrets.token_hex` / `crypto.randomUUID` (безопасные) vs `Math.random()` / `random.random()` (предсказуемые). Ищи использование предсказуемых генераторов для токенов, кодов подтверждения, сессий.
- Шифрование данных at rest: если хранятся чувствительные данные (PII, платёжные данные), зашифрованы ли они?
- TLS версия на исходящих вызовах: не отключён ли `verify=False`, `rejectUnauthorized: false`?

### 9. JWT-специфичные проверки

CVE 2026 года показывают, что JWT-атаки активны:
- **CVE-2026-1114** (lollms): слабый JWT secret → offline bruteforce → forge admin token.
- **CVE-2026-35039** (fast-jwt): cache collision → обход auth.
- **CVE-2026-33124** (Frigate): JWT persist после password reset.

Проверь:
- JWT secret: как минимум 32 случайных байта. Не hardcoded, не из предсказуемого источника.
- `alg: none` запрещён.
- Key confusion (RS256 vs HS256): verify-функция проверяет алгоритм против ожидаемого.
- `kid` header: если используется — значения валидируются, не позволяют path traversal / SQL injection.
- `exp` и `nbf` обязательно проверяются.
- Logout / password reset: инвалидируются ли выданные токены? Стандартный JWT без blacklist не может быть revoked — для чувствительных операций нужен server-side token store или короткий TTL + refresh pattern.
- Библиотеки: версии без известных CVE (fast-jwt ≥ фикс CVE-2026-35039).

### 10. CORS

- Разрешены ли произвольные origins (`Access-Control-Allow-Origin: *`)? Для API с аутентификацией это уязвимость.
- Используется ли динамический origin, который рефлектит заголовок запроса без валидации?
- Разрешены ли credentials (`Access-Control-Allow-Credentials: true`) одновременно с wildcard origin (невозможно, но бывают обходы через null origin)?
- Проверь, что список разрешённых origins — whitelist, а не regex с обходами (типа `.example.com.evil.com`).

### 11. GraphQL-специфичные проверки

Если проект использует GraphQL:
- Query depth limit и complexity limit — защита от resource exhaustion.
- Introspection выключен в production (или доступен только для авторизованных).
- Batching attacks: rate limit на уровне операций, не только HTTP-запросов.
- Field-level authorization: каждое sensitive поле имеет отдельный auth-check.

## Как искать в коде

```bash
# Route handlers
grep -rn "app\.\(get\|post\|put\|delete\|patch\|all\)\|router\.\(get\|post\|put\|delete\|patch\)\|@app\.\(get\|post\|put\|delete\)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"
grep -rn "export.*\(GET\|POST\|PUT\|DELETE\|PATCH\)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"

# BOLA-паттерны (ID из запроса без ownership check)
grep -rn "params\.id\|params\.userId\|req\.body\.id\|request\.args\|path_param\|findById\|findOne.*id" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# SSRF-паттерны
grep -rn "fetch\|axios\|http\.get\|requests\.get\|urllib\|httpx\|got(\|needle\|node-fetch" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Хеширование паролей
grep -rn "bcrypt\|argon2\|scrypt\|md5\|sha1\|sha256\|hashlib\|createHash\|pbkdf2" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Случайные значения
grep -rn "Math\.random\|random\.random\|random\.randint\|randomBytes\|secrets\.\|crypto\.random\|randomUUID\|uuid" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Mass assignment
grep -rn "req\.body\|request\.data\|request\.json\|params\.permit\|\.create(\|\.update(" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# NoSQL injection
grep -rn "\\\$ne\|\\\$gt\|\\\$lt\|\\\$where\|\\\$regex\|\\\$or" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# Error handlers с утечкой
grep -rn "err\.message\|error\.message\|err\.stack\|traceback\|DEBUG.*True\|res\.json.*error\|Response\.json.*error" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Fail-open patterns
grep -rn "catch.*return\s*true\|except.*return\s*True\|catch.*next()\s*$" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# Rate limiting
grep -rn "rateLimit\|rate.limit\|throttle\|slowapi\|rack.attack\|RateLimiter\|@Throttle" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# JWT
grep -rn "jwt\|jsonwebtoken\|jose\|fast-jwt\|pyjwt\|JWT_SECRET\|TOKEN_SECRET" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="package.json" --include="requirements.txt"

# TLS disabled на исходящих вызовах
grep -rn "verify=False\|rejectUnauthorized.*false\|insecureHTTPParser\|check_hostname=False" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# GraphQL
grep -rn "ApolloServer\|makeExecutableSchema\|buildSchema\|graphql-yoga\|introspection" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"
```
