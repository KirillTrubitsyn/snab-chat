# Логирование и мониторинг (OWASP A09:2025)

OWASP Top 10:2025 сохранил категорию (бывшая A09:2021 "Security Logging and Monitoring Failures"), с усилением акцента на alerting и integration с incident response.

## Что проверять

### 1. Audit logging

- Логируются ли мутации данных (create, update, delete)? Для каждой мутации должно быть зафиксировано: кто, когда, что, откуда (IP, user agent, session ID).
- Логируются ли события аутентификации: login (success / failure), logout, failed login, password change, 2FA toggle, device registration?
- Логируются ли admin-действия: изменение ролей, удаление пользователей, изменение конфигурации, tenant creation?
- Для AI-систем: логируются ли **tool calls** (function calling, MCP invocations) с полными аргументами, результатами, approver identity?
- Logs are **tamper-evident**: append-only, с cryptographic hashing или external write (WORM storage)?

### 2. PII в логах

- Проверь, не попадают ли в логи: пароли, токены, номера карт, паспортные данные, email-адреса (полные), телефоны, SSN.
- Ищи паттерны полного логирования объектов запроса / ответа: `console.log(req)`, `logger.info(JSON.stringify(body))`, `print(request.data)`.
- Для GDPR / 152-ФЗ: наличие PII в логах создаёт обязательства по хранению и удалению. См. `regulatory.md`.
- **LLM reasoning traces** (Claude extended thinking, Gemini thinking): если логируются — могут содержать PII из контекста.
- Best practice: structured logging с явными scrubbers для sensitive fields (pino-redact, structlog processors).

### 3. Log injection

- Если лог принимает пользовательский ввод: можно ли вставить fake log entries?
- Пример: пользователь отправляет username `admin\n[2024-01-01] INFO: User admin logged in successfully`. Если логгер не экранирует переносы строк, это создаёт поддельные записи.
- Structured logging (JSON) — защищено по дизайну. Plain-text logging без escaping — уязвимо.

### 4. Мониторинг и alerting

- Есть ли alerting на аномалии: mass failed logins, mass deletions, unusual API usage spikes, unusual geographic patterns?
- Настроен ли мониторинг доступности (uptime)?
- **Behavioral AI detection**: для AI-систем — анализ tool call patterns на аномалии (пользователь с ролью A внезапно использует tools, типичные для B).
- Rate limit monitoring: оповещение при массовых блокировках?
- **Cost anomaly alerting** для LLM-расходов (Denial of Wallet — см. `llm-security.md` LLM10).
- Failed audit log writes должны сами по себе генерировать alert.

### 5. Log retention и доступ

- Где хранятся логи: на диске сервера (теряются при перезапуске контейнера) или во внешнем сервисе (Datadog, CloudWatch, Axiom, Logtail)?
- Кто имеет доступ к логам? Нет ли публичных endpoint-ов для чтения логов (особенно опасно для dev/staging)?
- Есть ли retention policy (автоудаление через N дней для non-audit logs, отдельная policy для audit logs — обычно 1+ год)?
- Backup логов: в отдельной security zone, недоступной для app-accounts?

### 6. Error tracking

- Используется ли error tracking (Sentry, Bugsnag, Rollbar, DataDog APM)? Если да: не утекают ли секреты в error payloads?
- Sentry DSN: это `NEXT_PUBLIC_` переменная (клиентская, допустимо) или серверный auth token (нельзя на клиент)?
- `beforeSend` / data scrubbers настроены — удаляют ли authorization headers, request bodies, cookies?
- PII scrubbing в URL / request context?
- Source maps uploaded privately, не доступны публично?

### 7. Alerting на security events

- **Brute force**: после N failed logins — alert + lockout.
- **Privilege escalation**: user gained new role — alert.
- **Anomalous access**: login from new geography + new device — alert.
- **Data exfiltration signal**: user downloads unusually high volume — alert.
- **Regulatory-mandated alerting**: 24-hour notification pipelines для GDPR breach, CRA vulnerability, NIS2 incident — см. `regulatory.md`.

### 8. Forensics readiness

- При incident — хватит ли логов, чтобы восстановить timeline?
- Request correlation IDs проходят через все сервисы?
- Database audit extensions (pgaudit для Postgres) включены?
- Immutable audit trail для critical actions (financial, admin, data access)?

## Как искать в коде

```bash
# Логирование
grep -rn "console\\.log\|console\\.error\|logger\\.\|winston\|pino\|bunyan\|logging\\.\|log\\.\\(info\\|warn\\|error\\|debug\\)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# PII в логах
grep -rEn "(log|console|logger|print).*\\(.*?(password|token|secret|credit|card|ssn|passport|email|authorization)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Полное логирование request / body
grep -rn "console\\.log.*req\\b\|console\\.log.*request\\b\|logger.*JSON\\.stringify.*body\|logger.*req\\.headers" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# Error tracking
grep -rn "sentry\|Sentry\|bugsnag\|Bugsnag\|rollbar\|Rollbar\|SENTRY_DSN\|NEXT_PUBLIC_SENTRY" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" --include="*.env" --include="*.json"

# Sentry beforeSend (positive pattern)
grep -rn "beforeSend\|before_send\|denyUrls\|allowUrls" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# Audit events
grep -rn "audit\|auditLog\|activity.*log\|event.*log\|track.*event\|log.*action" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Structured logging redaction
grep -rn "redact\|scrubber\|filterSensitiveData\|sanitize.*log" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"
```

## Классификация

| Находка | Severity |
|---|---|
| Audit log не пишется для admin actions | High |
| Password / token / API key в логах | High |
| Нет error handler → stack trace в логах с PII | High |
| Reasoning traces LLM логируются без access control (могут содержать PII из контекста) | Medium |
| Sentry / APM без beforeSend scrubbing | Medium |
| Нет alerting на mass failed logins | Medium |
| Log injection (plain-text logging с user input) | Medium |
| Нет retention policy | Low |
| Sensitive endpoints не логируются вообще | Low |
