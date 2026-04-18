# Обработка исключительных ситуаций (OWASP A10:2025)

**Новая категория OWASP Top 10:2025**. Программы, некорректно обрабатывающие исключительные состояния (таймауты, out-of-memory, corruption, invariant violations, network failures, race conditions), могут переходить в небезопасное состояние — fail-open, утечка данных, DoS, обход авторизации. Категория консолидирует 24 CWE, ранее разбросанных по «code quality»: CWE-209 (error messages with secrets), CWE-476 (NULL dereference), CWE-636 (failing open).

SSRF (CWE-918) формально тоже включён в эту категорию в 2025 году, но мы разбираем SSRF в `api-surface.md` раздел 7, чтобы не дублировать.

## Что проверять

### 1. Fail-open vs fail-closed

Это принципиальный архитектурный выбор. Безопасный паттерн: **deny by default**.

- Когда auth middleware падает с исключением — возвращается 500 (fail-closed) или пропускает запрос дальше (fail-open)? Последнее — критично.
- Когда rate limiter не может подключиться к Redis — разрешает запрос или блокирует?
- Когда feature flag service недоступен — возвращает `false` (скрывает feature) или `true` (открывает всем)?
- Когда authorization policy evaluator недоступен — deny или allow?
- Когда LLM-guardrail классификатор падает — пропускает или блокирует запрос?

Паттерны, которые подозрительны:
```typescript
try {
  const user = await verifyToken(req.headers.authorization);
  req.user = user;
} catch (e) {
  // fail-open если нет return / throw
  next();  // ← критично
}
```

```python
try:
    policy_result = evaluate_policy(user, action)
except Exception:
    return True  # ← критично
```

### 2. Stack traces и error messages (CWE-209)

- Возвращаются ли stack traces в production-ответах? Ищи: `NODE_ENV !== 'production'`, `DEBUG = True`, отсутствие error handler middleware.
- Утекают ли имена таблиц, SQL-запросы, внутренние пути в сообщениях об ошибках?
- Ищи `catch` блоки, которые пробрасывают ошибку напрямую: `res.json({ error: err.message })`, `return Response.json(error)`, `return jsonify(str(e))`.
- Unhandled rejections / uncaught exceptions — есть ли global handler, который логирует, но возвращает generic `500 Internal Server Error`?

Безопасный паттерн:
```typescript
try {
  // ...
} catch (e) {
  logger.error({ err: e, userId: req.user?.id }, "operation failed");
  return Response.json({ error: "Operation failed" }, { status: 500 });
}
```

### 3. NULL dereference и unchecked returns (CWE-476)

- Возвращают ли функции `null` / `None` / пустое значение в edge cases, и есть ли обработка этого в вызывающем коде?
- TypeScript strict mode (`strictNullChecks: true`)? Python с type hints и `mypy` strict?
- Unchecked return values от auth-функций: `getUser()` вернула null, но код продолжает считать, что user авторизован.

### 4. Race conditions в error paths

- Side effects в catch-блоках: отправка email, запись в БД, запрос к внешнему API — что если сам catch бросит исключение?
- Атомарность транзакций при ошибке: откатывается ли БД, если часть операций прошла, а часть нет?
- Compensating actions: если внешний call прошёл, но локальное сохранение упало — что делать?

### 5. Resource exhaustion и timeouts

- Таймауты на все внешние вызовы: HTTP-клиенты, БД-запросы, LLM API, external tools. Без таймаутов — зависшие requests держат connection pool.
- Circuit breakers для часто недоступных сервисов.
- Backpressure в streaming: если клиент медленнее, чем генерация — не накапливается ли памяти?
- Max payload size на endpoints: без ограничения — атакующий шлёт 10GB body.
- Max query complexity (GraphQL, SQL): без ограничений — DoS через nested query.

### 6. Silent failures в background jobs

- Async handlers (queue workers, cron jobs): как они обрабатывают ошибки? Retry policy, dead-letter queue, alerting на failures?
- Audit log failures: если audit log не записался из-за ошибки — завершает ли основная операция? Или блокируется? В security-critical системах блокировка правильна.
- Webhook delivery failures: retry с exponential backoff, но с maximum retry и dead-letter.

### 7. Специфичные для Next.js / React

- `error.tsx` boundaries: не утекают ли детали ошибки в UI?
- Server Actions errors: `redirect()` throws specific NEXT_REDIRECT error — catch-all catch может случайно его поглотить.
- Suspense boundaries: на fallback можно незаметно пройти, если error throw'ится во время render.

## Как искать в коде

```bash
# Stack traces в production
grep -rn "err\.stack\|error\.stack\|traceback\|DEBUG\\s*=\\s*True\|development.*error" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Error message leak
grep -rEn "(res|Response)\\.json.*error\\.?message|jsonify\\(str\\(" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# Fail-open patterns
grep -rEn "catch\\s*\\([^)]*\\)\\s*\\{[^{}]*next\\(\\)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"
grep -rEn "except.*:\\s*return\\s+True" --include="*.py"
grep -rEn "except.*:\\s*pass" --include="*.py"  # silent failure

# Таймауты (отсутствие)
grep -rn "fetch(\|axios\.\|requests\.get\|http\.request" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"
# Затем вручную проверь, есть ли timeout: / timeout= в этих вызовах

# Unhandled errors
grep -rn "unhandledRejection\|uncaughtException\|process\.on\\s*\\(\\s*[\"']error" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"

# TypeScript strict config
grep -rn "strictNullChecks\|\"strict\":" tsconfig.json 2>/dev/null
```

## Классификация

| Находка | Severity |
|---|---|
| Fail-open в auth middleware | Critical |
| Fail-open в authorization policy evaluator | Critical |
| Stack traces в production HTTP responses | High |
| Fail-open в rate limiter / feature flag с security-импликациями | High |
| Нет таймаутов на внешние API-вызовы | Medium |
| Silent failures в audit log | Medium |
| `error.message` возвращается клиенту | Medium |
| Нет global error handler | Low |
