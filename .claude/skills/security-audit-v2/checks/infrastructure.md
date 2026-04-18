# Инфраструктура и заголовки безопасности

## Что проверять

### 1. Security Headers

Проверь конфигурацию HTTP-заголовков:

| Заголовок | Что проверить | Риск при отсутствии |
|---|---|---|
| `Content-Security-Policy` | Нет ли `unsafe-inline`, `unsafe-eval`, `*` в директивах? Nonce / hash для inline scripts? | XSS |
| `Strict-Transport-Security` | Присутствует с `max-age >= 31536000`, `includeSubDomains`, `preload`? | Downgrade-атака |
| `X-Frame-Options` | `DENY` или `SAMEORIGIN`? Альтернативно: CSP `frame-ancestors` | Clickjacking |
| `X-Content-Type-Options` | `nosniff`? | MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` или строже? | Утечка URL |
| `Permissions-Policy` | Ограничены ли camera, microphone, geolocation, payment, fullscreen? | Доступ к оборудованию |
| `Cross-Origin-Opener-Policy` | `same-origin` для изоляции от malicious popups? | Cross-origin attacks |
| `Cross-Origin-Embedder-Policy` | `require-corp` для SharedArrayBuffer? | Side-channel атаки |
| `Cross-Origin-Resource-Policy` | `same-origin` для приватных ресурсов? | Spectre-like атаки |

Где искать: `next.config.js` (headers), `middleware.ts`, Express `helmet()`, Nginx / Apache конфиги, Vercel / Cloudflare WAF rules.

### 2. CSP best practices 2026

- **Strict CSP**: `script-src 'self' 'nonce-{random}'` вместо `unsafe-inline`.
- `'strict-dynamic'` для loader-скриптов.
- Запрет `'unsafe-eval'` полностью.
- `base-uri 'self'` — защита от base tag injection.
- `form-action 'self'` — защита от form hijacking.
- `object-src 'none'` — запрет Flash / Java applet-like content.
- `upgrade-insecure-requests` — автоматический HTTPS.
- CSP Reporting: `report-uri` или `report-to` — сбор violations.

### 3. CORS

- Разрешены ли произвольные origins (`Access-Control-Allow-Origin: *`)? Для API с аутентификацией это уязвимость.
- Используется ли динамический origin, который рефлектит заголовок запроса без валидации?
- Разрешены ли credentials (`Access-Control-Allow-Credentials: true`) одновременно с wildcard origin?
- Проверь, что список разрешённых origins — whitelist, а не regex с обходами (типа `.example.com.evil.com`).
- Null origin (`Access-Control-Allow-Origin: null`) — опасный паттерн, атакующий может получить null origin через sandboxed iframe.

### 4. HTTPS и транспорт

- Принудительный HTTPS: есть ли редирект с HTTP?
- HSTS preload list submission для основных доменов?
- Certificate: используется ли автоматическое обновление (Let's Encrypt, AWS ACM)?
- TLS-версия: отключены ли TLS 1.0 и 1.1? Минимум TLS 1.2, рекомендуется 1.3.
- Cipher suites: отключены ли слабые (3DES, RC4, MD5)?
- Certificate transparency monitoring: алертинг на новые сертификаты для доменов?

### 5. Deployment platforms

**Railway**: проверь `railway.json` / `railway.toml` — нет ли exposed debug ports, env переменных в конфиге вместо Railway secrets.

**Vercel**: 
- `vercel.json` — правильны ли rewrites / redirects, нет ли open redirects?
- Environment variables: production vs preview vs development — нет ли production secrets в preview?
- Preview deployments: защищены ли auth от public access (Vercel Password Protection, Vercel Authentication)?
- Deployment protection for sensitive branches.

**Cloudflare**: 
- Workers / Pages: secrets через Wrangler, не через `wrangler.toml`.
- WAF rules: настроены ли?
- Bot management включён для чувствительных endpoints?

**Docker**: 
- Dockerfile: запускается ли процесс от root (`USER` directive)?
- Multi-stage build: исключает ли build-tools из final image?
- `.dockerignore` исключает `.env`, `.git`, `node_modules`, `*.md`?
- Base image: pinned к digest (`@sha256:`), не к tag?
- `HEALTHCHECK` определён?
- Scanning: используется ли Trivy / Grype в CI?

**Fly.io**: проверь `fly.toml` — внутренние порты, health checks, secrets через `fly secrets set`.

**Kubernetes** (если используется):
- Pod Security Standards: restricted profile.
- NetworkPolicies для pod-to-pod isolation.
- RBAC: least privilege ServiceAccounts.
- Secrets: через Vault / External Secrets Operator / Sealed Secrets, не plain Kubernetes Secrets.

### 6. DNS и домены

- Нет ли CNAME-записей, указывающих на деактивированные сервисы (subdomain takeover)? Инструменты: `takeover`, `subjack`.
- Если используется wildcard DNS — это расширяет поверхность атаки.
- DNSSEC настроен?
- SPF, DKIM, DMARC для email-доменов — на `reject` (не `none`)?
- CAA-запись ограничивает CA, которые могут выдать сертификат?

### 7. Serverless / Edge функции

- Cold start секреты: загружаются ли на старте или при каждом запросе (cost optimization)?
- Cross-function isolation: не делят ли функции файловую систему / память случайно?
- Concurrency limits и resource limits установлены?

### 8. CDN / WAF

- Next.js / SPA на CDN: правильно ли кешируются authenticated pages (не кешируются в shared cache)?
- `Cache-Control: private` для user-specific content.
- WAF rules: OWASP Core Ruleset включён?
- Rate limiting на CDN level (не только в приложении)?

## Как искать в коде

```bash
# Security headers
grep -rn "helmet\|Content-Security-Policy\|X-Frame-Options\|Strict-Transport\|X-Content-Type\|Referrer-Policy\|Permissions-Policy\|Cross-Origin" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.conf" --include="*.json"

# CSP анти-паттерны
grep -rEn "unsafe-inline|unsafe-eval|\\*.*script-src|script-src.*\\*" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.conf"

# CORS
grep -rn "cors\|Access-Control\|allowedOrigins\|origin.*\\*\|CORS_ALLOWED" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.conf" --include="*.json" --include="*.yml"

# Vercel / deployment configs
ls -la railway.json railway.toml vercel.json fly.toml docker-compose*.yml Dockerfile .dockerignore wrangler.toml netlify.toml 2>/dev/null

# Dockerfile проверки
grep -n "^USER\|^FROM\|^HEALTHCHECK" Dockerfile* 2>/dev/null

# Subdomain takeover candidates
grep -rn "CNAME\|herokuapp\|github\\.io\|cloudfront\|s3-website\|azurewebsites" --include="*.zone" --include="*.tf" --include="*.yaml" --include="*.yml" 2>/dev/null

# Kubernetes security
grep -rn "runAsUser\|runAsNonRoot\|privileged\|allowPrivilegeEscalation\|capabilities" --include="*.yaml" --include="*.yml"

# Cache-Control
grep -rn "Cache-Control\|cacheControl\|max-age" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.conf"
```
