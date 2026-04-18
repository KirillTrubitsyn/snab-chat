# Бизнес-логика

Бизнес-логика — уязвимости, которые не покрываются стандартными SAST / DAST сканерами, потому что они специфичны для приложения. Требуют понимания domain и намерений пользователя.

## Что проверять

### 1. Обход оплаты и квот

- Если есть платные функции или подписки: проверяется ли уровень подписки на **сервере**, или только на клиенте?
- Может ли пользователь бесплатного плана вызвать API premium-функции напрямую?
- Есть ли лимиты использования (requests/day, storage, API calls, LLM tokens)? Проверяются ли они на бэкенде?
- Может ли пользователь обнулить свой счётчик использования через API (race condition на обновление счётчика)?
- Webhook-обработка от платёжных систем (Stripe, YooKassa): проверяется ли signature? Идемпотентна ли обработка event'ов (retry на уровне Stripe может дублировать события)?
- Promo codes и refunds: применимы ли они только раз? Есть ли лимит на применение?

### 2. Feature flags и A/B тесты

- Если используются feature flags: хранятся ли они на клиенте (можно подменить в DevTools)?
- Может ли пользователь активировать скрытые / premium-функции через манипуляцию с localStorage / cookies / URL-параметрами?
- Feature flag должен проверяться на сервере для security-critical функций, не только на клиенте.

### 3. Race conditions (TOCTOU)

- Time-of-check-to-time-of-use: между проверкой условия и выполнением действия может вклиниться конкурентный запрос.
- Типичные сценарии: двойное списание баланса, создание дублей при быстрых повторных запросах, бронирование одного слота двумя пользователями, накрутка referral bonus.
- Защита: database-level constraints, оптимистичная блокировка (`UPDATE ... WHERE version = @old_version`), idempotency keys, atomic increments.

### 4. Enumeration

- Можно ли перебирать ресурсы (пользователей, документы, заказы) через последовательные ID?
- Используются ли UUID (v4 или ULID) вместо автоинкрементных ID для публичных идентификаторов?
- Различаются ли ответы для существующих и несуществующих ресурсов (timing, HTTP-код, сообщение)?
- Email / phone enumeration в registration, password reset (см. `auth.md` раздел 6).

### 5. Abuse-сценарии

- Можно ли отправить массу запросов на создание объектов (спам-регистрации, создание тысяч записей, embedding poisoning через массовый ingestion)?
- Есть ли captcha или anti-bot защита на публичных формах?
- Может ли пользователь использовать функции приложения для атак на третьих лиц (отправка email через приложение, webhook forwarding, SSRF через сервис preview)?
- **AI-abuse**: может ли пользователь использовать LLM-функцию приложения для генерации harmful content (phishing, malware, CSAM)? Есть ли moderation?
- **Денежные атаки**: если приложение перечисляет третьим лицам (affiliates, referrers, creators) — можно ли накрутить?

### 6. Идемпотентность

- Повторная отправка формы / retry запроса: создаётся ли дубликат, или операция идемпотентна?
- Для платёжных / критичных операций: есть ли idempotency key?
- Email / SMS / push notifications: есть ли deduplication при повторной отправке?

### 7. Финансовая целостность

- Если есть любые финансовые операции (balance, transactions, escrow):
  - Используются ли decimal / arbitrary precision (не float) для денежных сумм?
  - Проверяется ли sufficient balance перед debit'ом?
  - Атомарные транзакции: БД-level, с retry policy?
  - Audit trail всех операций?
  - Reconciliation pipeline сравнивает внутренний state с внешним (платёжный провайдер)?

### 8. Время и дата

- Time zones: сервер использует UTC, frontend — local. Bugs on DST transitions, leap seconds.
- Time-based access (session expiry, promo valid-until): проверяется ли server-side, не trust client-side?
- Replay attacks: nonce / timestamp в signed requests с допустимым skew?

### 9. Workflow и state machines

- Если есть state machine (order: draft → submitted → approved → fulfilled): может ли пользователь обойти состояния (напрямую вызвать "approve")?
- Checks на допустимые переходы на сервере, не только на клиенте.
- Rollback состояний: откатываются ли связанные side-effects?

### 10. User-controlled data в системных операциях

- User-controlled filename / email / URL в API-вызовах — проверяется ли формат?
- Injection через поля: SMTP header injection через email `To`, log injection через username с newline.

## Как искать в коде

```bash
# Проверки подписки / плана
grep -rn "plan\|subscription\|tier\|premium\|pro\|limit\|quota\|usage\|credits\|allowance\|tokens_used" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Feature flags
grep -rn "feature.*flag\|featureFlag\|LaunchDarkly\|unleash\|flagsmith\|splitio\|FEATURE_\|posthog.*feature" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" --include="*.env"

# Sequential IDs
grep -rn "autoIncrement\|serial\|SERIAL\|AUTO_INCREMENT\|IDENTITY\|@Id.*auto" --include="*.sql" --include="*.prisma" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Idempotency
grep -rn "idempoten\|retry\|dedup\|unique.*constraint\|ON CONFLICT\|idempotency_key" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" --include="*.sql" --include="*.prisma"

# Webhook handlers (Stripe / YooKassa)
grep -rn "stripe.*webhook\|yookassa.*webhook\|webhook.*signature\|verify.*webhook\|constructEvent\|construct_event" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Money / decimal types
grep -rn "Decimal\|BigDecimal\|\bdecimal(\|@Column.*decimal\|number.*money\|float.*balance" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.sql" --include="*.prisma"

# Atomic updates
grep -rn "INCR\|DECR\|FOR UPDATE\|WITH NOWAIT\|optimisticLock\|version.*conflict" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.sql"
```
