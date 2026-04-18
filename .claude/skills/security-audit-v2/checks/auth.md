# Аутентификация и авторизация

## Что проверять

### 1. Обход аутентификации

- Найди все middleware/функции, отвечающие за проверку аутентификации (auth middleware, guards, decorators, server actions authentication).
- Проверь, применяются ли они ко всем защищённым маршрутам или есть пробелы.
- Проверь, можно ли обратиться к защищённым API-эндпоинтам напрямую (curl / Postman), минуя UI. Это ключевой тест: если фронтенд скрывает кнопку, но бэкенд не проверяет токен, защиты нет.

### 2. Broken Access Control (OWASP A01:2025)

Категория A01 осталась на первом месте в OWASP Top 10:2025 и теперь включает также SSRF (поглощён из A10:2021).

- **BOLA / IDOR**: проверь, привязаны ли операции чтения/записи/удаления к текущему пользователю. Ищи паттерны, где `id` берётся из URL/body без сверки с `req.user` или `session.user`. Подробная методология — в `api-surface.md` раздел 2. **BOLA — уязвимость №1 по статистике 2026 года.**
- **BOPLA**: отдельная проверка — может ли пользователь изменить поле, которое не должен (role, tenant_id, balance)? См. раздел Mass Assignment в `api-surface.md`.
- **Horizontal escalation**: может ли пользователь A получить доступ к данным пользователя B, подставив чужой ID?
- **Vertical escalation**: может ли обычный пользователь вызвать admin-эндпоинт? Ищи проверки роли (role check) и убедись, что они не только на фронтенде.
- **Bulk-операции**: если есть `DELETE ?all=true` или batch-эндпоинты, проверь, что scope ограничен текущим пользователем.
- **Cross-tenant access**: для мультитенантных приложений — tenant_id берётся из JWT/session, а не из request body.

### 3. Сессии и токены

- Где хранятся токены на клиенте: localStorage (уязвимо к XSS) vs httpOnly cookie (предпочтительно)?
- Проверь refresh-flow: можно ли переиспользовать старый refresh-токен после ротации (refresh token rotation anti-replay)?
- Logout: инвалидируется ли токен на сервере, или только удаляется на клиенте?
- Время жизни access-токена: если более 1 часа, это повышенный риск.
- После password reset — инвалидируются ли все ранее выданные токены (CVE-2026-33124 в Frigate: JWT persist после password reset → hijack)?

### 4. JWT-специфичные проверки

Актуальные JWT-CVE 2026:
- **CVE-2026-1114** (lollms, weak JWT secret → offline bruteforce → forge admin).
- **CVE-2026-35039** (fast-jwt cache collision → обход auth).
- **CVE-2026-33124** (Frigate, JWT persist post-reset).

Проверь:
- JWT secret: как минимум 32 случайных байта, загружен из secure secret store, не hardcoded.
- `alg: none` запрещён в верификации.
- Key confusion (RS256 vs HS256): verify-функция проверяет алгоритм против ожидаемого, не доверяет header'у.
- `kid` header: если используется — значения валидируются, не позволяют path traversal.
- `exp` и `nbf` обязательно проверяются.
- Библиотеки: `jsonwebtoken`, `jose`, `fast-jwt` — актуальные версии без известных CVE.

### 5. 2FA

- Если реализована: есть ли grace period, позволяющий обойти 2FA?
- Есть ли fallback без 2FA (например, magic link без 2FA-проверки)?
- Рейт-лимит на ввод кода: можно ли перебирать 6-значный код (100000 попыток без rate limit — часы вычислений)?
- Recovery codes: одноразовые? Инвалидируются после использования?

### 6. Регистрация и восстановление пароля

- **Enumeration**: различаются ли ответы при «email не найден» vs «неверный пароль»? Различаются ли по timing (username lookup быстрее, чем password hash)? Это позволяет перебирать существующие аккаунты.
- Ссылка сброса пароля: одноразовая? Есть TTL (максимум 1 час)? Привязана к конкретному пользователю? Инвалидирует ли все предыдущие tokens?
- Сложность пароля: есть ли минимальные требования? Есть ли проверка против известных утечек (HIBP API)?
- Email verification: нужна ли для login или только для регистрации?

### 7. Современные auth-провайдеры

Если используется managed auth:
- **Supabase Auth**: проверь, что на клиенте используется `anon` key, а `service_role` key только на сервере. RLS-политики проверяются в модуле `database.md`.
- **Clerk, Auth0, Kinde, Workos, Stack Auth**: проверь конфигурацию session callbacks — не добавляются ли в session token данные, которые не должны быть на клиенте.
- **NextAuth / Auth.js**: проверь session callback и JWT callback на утечку sensitive data. Проверь CSRF token handling.
- **Passkeys / WebAuthn**: если используются — rp_id правильно ограничен доменом, не позволяет phishing через subdomain?

### 8. Фреймворк-специфичное

**Next.js (App Router)**: 
- `middleware.ts` должен покрывать все защищённые маршруты. Route handlers в `app/api/` могут не наследовать middleware автоматически при некоторых конфигурациях.
- Server Actions (`"use server"`) требуют проверки auth явно, они вызываются по HTTP и не защищены просто потому что не экспонируют видимый endpoint.
- Middleware работает на Edge Runtime — не все crypto / bcrypt доступны. Ошибка реализации в middleware часто приводит к fail-open.

**Supabase**: проверь, что на клиенте — `anon` key, `service_role` — только на сервере. RLS детально — в `database.md`.

**Express / Fastify**: проверь, что auth middleware применяется через `app.use()` к группе маршрутов, а не забыт на отдельных route handlers.

**Django**: проверь `@login_required`, `@permission_required`, `IsAuthenticated` в DRF viewsets. Проверь `get_queryset` — не возвращает ли чужие данные.

**Rails**: проверь `before_action :authenticate_user!`, Pundit / CanCanCan policies. Проверь `scope_for` правильно скоупит queries.

**FastAPI**: Dependencies с `Depends(get_current_user)` должны применяться ко всем защищённым endpoints. Проверь, что нет endpoints без `Depends`.

## Как искать в коде

```bash
# Middleware аутентификации
grep -rn "auth\|authenticate\|requireAuth\|isAuthenticated\|protect\|guard\|@login_required\|@auth\|verify_token\|getSession\|getUser\|useSession" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Проверки ролей
grep -rn "role\|isAdmin\|admin_only\|permission\|authorize\|@roles\|@requires\|can?" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# JWT-конфигурация
grep -rn "jwt\|jsonwebtoken\|jose\|fast-jwt\|pyjwt\|JWT_SECRET\|TOKEN_SECRET\|alg.*none" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" --include="*.json" --include="*.env"

# IDOR / BOLA паттерны (ID из параметров без проверки ownership)
grep -rn "params\.id\|params\.userId\|req\.body\.id\|request\.args\|path_param\|findById\b" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Tenant из body (анти-паттерн)
grep -rn "body\.tenant\|body\.tenantId\|req\.body\..*[Tt]enant\|request\.data\..*tenant" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Server Actions в Next.js без auth
grep -rn "\"use server\"\|'use server'" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"

# Enumeration-паттерны
grep -rn "email not found\|user not found\|invalid email\|User does not exist" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"
```
