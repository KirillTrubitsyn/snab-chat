# Клиентская безопасность

Применяй этот модуль при наличии фронтенда (React, Vue, Svelte, Angular, Astro, HTML/JS).

## Что проверять

### 1. XSS (Cross-Site Scripting)

- Ищи места, где пользовательский ввод вставляется в DOM без экранирования.
- **React**: использование `dangerouslySetInnerHTML` — каждый случай требует проверки: санитизируется ли HTML (DOMPurify)?
- **Vue**: директива `v-html` — аналог `dangerouslySetInnerHTML`.
- **Svelte**: `{@html ...}` — аналогично.
- **Vanilla JS**: `innerHTML`, `outerHTML`, `document.write()`, `insertAdjacentHTML()`, `$(...).html()`.
- **Server-side rendering**: если данные из БД рендерятся в HTML на сервере без экранирования.
- **Markdown rendering**: если пользовательский Markdown рендерится в HTML, включена ли санитизация? Многие библиотеки (marked, remark) по умолчанию не фильтруют `<script>`, `<img onerror>`, `javascript:` URI.
- **LLM output рендеринг**: см. `llm-security.md` LLM05. Output LLM = untrusted input.
- **URL-based**: `href="${userInput}"` — проверь защиту от `javascript:`, `data:` URI.

### 2. Хранение чувствительных данных

- Хранятся ли токены, пароли, PII в `localStorage` или `sessionStorage`? Эти хранилища уязвимы к XSS: любой скрипт на странице имеет к ним доступ.
- Предпочтительно: `httpOnly` cookies для токенов.
- Кешируются ли чувствительные данные в state management (Redux / Zustand / Pinia / TanStack Query) дольше необходимого?
- IndexedDB с sensitive data — уязвим к XSS так же, как localStorage.
- Service Worker caches: не должны сохранять authenticated API responses без explicit TTL.

### 3. Open Redirect

- Ищи редиректы, где URL берётся из параметров запроса: `?redirect=`, `?returnUrl=`, `?next=`, `?callback=`.
- Проверь: валидируется ли URL? Можно ли подставить внешний домен (`?redirect=https://evil.com`)?
- Паттерны: `window.location = params.redirect`, `router.push(query.returnUrl)`, `res.redirect(req.query.next)`.
- Защита: whitelist допустимых URL, или как минимум — проверка что URL относительный или принадлежит same-origin.
- Open redirect может chain'иться с phishing и token theft (OAuth callback redirect).

### 4. PostMessage

- Если приложение использует `window.postMessage`: проверяется ли origin входящих сообщений?
- `event.origin` должен проверяться против whitelist. Без проверки любой iframe может отправлять команды.
- `event.source` не должен использоваться для авторизации.

### 5. CSRF

- Для приложений с cookie-based auth: есть ли CSRF-защита (csrf token, SameSite cookie)?
- SameSite=Lax / Strict в cookie — обязательно.
- Для SPA с bearer tokens в headers: CSRF обычно не актуален, но проверь, что токен не передаётся через cookie без SameSite.
- Double-submit cookie pattern если есть legacy endpoints.

### 6. Sensitive Data in URL

- Передаются ли токены, пароли, PII через URL query parameters? Они попадают в логи сервера, историю браузера, Referer header.
- Password reset tokens в URL — одноразовые + короткий TTL.
- Magic link tokens — аналогично.

### 7. Source Maps и bundle content

- Доступны ли source maps в production? Они раскрывают исходный код. Проверь: `.map` файлы, `sourceMappingURL` в бандлах, конфигурация webpack / Vite / Next.js.
- Комментарии, TODO с sensitive info попадают в bundle.
- Environment variables: `NEXT_PUBLIC_*`, `VITE_*` попадают в client bundle — см. `secrets.md`.

### 8. Client-side dependency risks

- Сторонние скрипты на странице (analytics, chat widgets, A/B testing): все они получают полный DOM access. SRI (Subresource Integrity) для pinned версий?
- Iframe для third-party content: sandbox attribute установлен?
- Third-party cookies и tracking: соответствуют ли cookie consent?

### 9. Browser-specific защита

- **Trusted Types** (CSP feature): блокирует trivial XSS paths.
- **COOP/COEP/CORP** заголовки — см. `infrastructure.md`.
- **FLoC / Topics API**: явное opt-out если не нужно.
- **Clipboard API**: writeText sensitive data — только по explicit user action.

### 10. Client-side secrets

В SPA / JAMstack часто забывают: **всё, что есть в клиентском коде, видно пользователю**.
- API keys для third-party сервисов в клиенте — как правило анти-паттерн, нужно proxy через backend.
- Исключения (например, Stripe publishable key, Supabase anon key) — явно по design, но проверить.

## Как искать в коде

```bash
# XSS-паттерны
grep -rn "dangerouslySetInnerHTML\|v-html\|innerHTML\|outerHTML\|document\\.write\|insertAdjacentHTML\|{@html" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.vue" --include="*.svelte" --include="*.html"

# localStorage с секретами
grep -rEn "(localStorage|sessionStorage)\\.(set|get)Item.*?(token|password|secret|key|auth|jwt|credential)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.vue" --include="*.svelte"

# Open redirect
grep -rEn "(redirect|returnUrl|next=|callback=)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.vue" --include="*.svelte" --include="*.py" --include="*.rb"
grep -rEn "(window\\.location\\s*=|router\\.push.*query|res\\.redirect.*req\\.(query|params))" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# javascript: URIs
grep -rEn "href\\s*=\\s*\\{.*?(url|link)|javascript:" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.vue" --include="*.svelte"

# PostMessage
grep -rn "postMessage\|addEventListener.*message" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.vue" --include="*.svelte"

# Source maps
grep -rn "sourceMappingURL\|devtool.*source.map\|productionSourceMap\|build.*sourcemap" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.config.*"

# SRI
grep -rEn "<script[^>]+src=[^>]+integrity=" --include="*.html" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"

# Cookies с SameSite
grep -rEn "cookie|Set-Cookie|SameSite" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb"

# Third-party скрипты
grep -rEn "<script[^>]+src=\"https?://[^/]+[^\"]+\"" --include="*.html" --include="*.tsx" --include="*.jsx" --include="*.vue" --include="*.svelte"
```
