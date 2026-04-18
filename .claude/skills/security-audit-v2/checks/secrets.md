# Секреты и credentials

## Что проверять

### 1. Хардкоженные секреты в коде

Ищи в рабочем дереве проекта:
- API keys, токены, пароли, private keys.
- Connection strings с встроенными credentials.
- Webhook secrets, encryption keys.
- Паттерны: строки длиной > 20 символов в кавычках рядом с переменными, содержащими `key`, `secret`, `token`, `password`, `auth`, `credential`.

Современные паттерны API-ключей по состоянию на 2026 год:

| Префикс / паттерн | Провайдер |
|---|---|
| `sk-` | OpenAI |
| `sk-ant-` | Anthropic |
| `sk-proj-` | OpenAI (project keys) |
| `pk_live_`, `sk_live_` | Stripe |
| `ghp_`, `gho_`, `ghs_`, `ghu_` | GitHub |
| `glpat-` | GitLab Personal Access Token |
| `xoxb-`, `xoxp-`, `xoxa-` | Slack |
| `AKIA`, `ASIA` | AWS access key / temporary |
| `AIza` | Google API |
| `ya29.` | Google OAuth |
| `eyJhbG` | JWT token (base64 header) |
| `dop_v1_` | DigitalOcean |
| `rnd_` | Render |
| `hf_` | Hugging Face |
| `fw_` | Fireworks AI |
| `xai-` | xAI / Grok |
| `sk-or-` | OpenRouter |
| `r8_` | Replicate |
| `gsk_` | Groq |
| `sbp_` | Supabase personal token |
| `eyJhbGciOiJIUzI1NiI...service_role` | Supabase service role (base64 JWT) |
| `nvapi-` | NVIDIA API |
| `mcp_` | MCP tokens (нестандартизированные) |

### 2. Секреты в git-истории

Даже если секрет удалён из текущего кода, он остаётся в истории коммитов. Выполни:

```bash
# Поиск добавлений/удалений секретов (правильный синтаксис через -G regex)
git log --all -p -G "(api[_-]?key|secret[_-]?key|password|token|AKIA|sk-|sk-ant-|ghp_|glpat-|hf_|xai-|service_role|private_key)" | head -500

# Альтернатива: отдельные -S вызовы для конкретных строк
for pattern in "SUPABASE_SERVICE_ROLE" "sk-ant-api03" "AKIAI" "ghp_" "glpat-"; do
  echo "=== $pattern ==="
  git log --all --oneline -S "$pattern"
done

# Были ли когда-либо закоммичены .env-файлы
git log --all --full-history -- "*.env" "*.env.local" "*.env.production" "*.env.staging"

# Все строки, выглядящие как секреты, в истории
git log --all -p | grep -E "(sk-ant-|sk-proj-|AKIA|ghp_|glpat-|eyJhbGci)" | head -50
```

Если .env когда-либо был в git — секреты, которые были в нём, должны быть **немедленно ротированы**, даже если файл потом удалён. Git history восстанавливается.

### 3. Env-переменные и конфигурация

- Есть ли `.env`, `.env.local`, `.env.production` в `.gitignore`?
- Есть ли `.env.example` с реальными значениями вместо плейсхолдеров?
- **Критично для Next.js / Nuxt / Vite / CRA / Remix**: переменные с префиксом `NEXT_PUBLIC_` / `NUXT_PUBLIC_` / `VITE_` / `REACT_APP_` / `PUBLIC_` попадают в клиентский бандл. Проверь, что среди них нет `service_role`, `DATABASE_URL`, admin tokens, provider secrets.
- Проверь `import "server-only"` (Next.js): модули с секретами должны быть помечены, чтобы исключить случайный импорт на клиенте.
- Проверь `import "client-only"` для файлов, которые никогда не должны попасть на сервер.

### 4. Утечка через source maps и public bundles

**Инцидент апреля 2026**: Anthropic случайно опубликовала Claude Code source через public npm source map. Атакующие немедленно weaponized это, создав fake «leaked Claude Code» репозитории для distribution малвари. Это vector, который недооценён многими командами.

Проверь:
- Source maps (`.map` файлы) не публикуются в production. Проверь `next.config.js` (`productionBrowserSourceMaps: false`), `vite.config.js` (`build.sourcemap: false`), webpack (`devtool` не `source-map` в production).
- Публичные npm-пакеты (если компания публикует packages): проверь `package.json` `files` field и `.npmignore` — не попадают ли `.env`, `.git`, `src/**/*.ts` в опубликованный пакет.
- Build artifacts на CDN: не доступны ли `.map`, `.env.production` по предсказуемым путям?
- Комментарии `//# sourceMappingURL=` в production-bundle, указывающие на внутренние source maps.

### 5. Секреты в документации и конфигах

- README, SETUP.md, CONTRIBUTING.md с реальными токенами.
- `docker-compose.yml` с захардкоженными паролями БД.
- CI/CD конфиги (`.github/workflows/*.yml`) с inline-секретами вместо GitHub Secrets.
- Swagger / OpenAPI спеки с примерами, содержащими реальные токены.
- Postman-коллекции в репозитории с заполненными credentials.

### 6. Логи

- Проверь, не логируются ли токены, пароли, API keys: `console.log(req.headers)`, `logger.info(credentials)`, `print(request.data)`.
- Ищи паттерны логирования полного объекта запроса/ответа.
- Reasoning traces LLM (Claude extended thinking, Gemini thinking, o-series): если логируются — могут содержать credentials, которые модель видела в контексте.

### 7. Эволюция: workload identity вместо static secrets

Современный best practice 2025–2026 (позиция Gartner, Akeyless, Aembit): **уходить от static secrets в пользу workload identity**.

Проверь, есть ли возможность мигрировать:
- OIDC federation: `aws-actions/configure-aws-credentials` с `role-to-assume`, `permissions: id-token: write` — вместо AWS access keys в GitHub Secrets.
- GCP Workload Identity Federation — вместо service account keys.
- Azure Managed Identity — вместо storage keys.
- Vault / AWS Secrets Manager / GCP Secret Manager с JIT-retrieval — для legacy-секретов, которые нельзя убрать.
- Ephemeral credentials с TTL минут, auto-expiry после task completion.

Если в CI/CD используются long-lived access keys — это **High severity finding** с рекомендацией миграции.

## Как искать в коде

```bash
# Хардкоженные секреты по известным префиксам
grep -rEn "(sk-ant-api|sk-proj-|sk-or-|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\\-]{35}|ghp_[0-9a-zA-Z]{36}|gho_|ghs_|ghu_|glpat-[0-9a-zA-Z_\\-]{20}|xoxb-|xoxp-|dop_v1_|rnd_[0-9a-zA-Z_\\-]+|hf_[A-Za-z]{34}|fw_|xai-|r8_[A-Za-z0-9]{36}|gsk_|sbp_|nvapi-|eyJhbGci)" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" \
  --include="*.json" --include="*.yml" --include="*.yaml" --include="*.env" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next

# Переменные с секретами
grep -rEn "API_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD|DATABASE_URL|SUPABASE_SERVICE_ROLE|JWT_SECRET|ENCRYPTION_KEY|WEBHOOK_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" --include="*.env*" \
  --exclude-dir=node_modules --exclude-dir=.git

# Next.js: секреты в публичных переменных
grep -rEn "NEXT_PUBLIC_.*(SECRET|KEY|PASSWORD|SERVICE_ROLE|ADMIN|TOKEN)" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.env*" \
  --exclude-dir=node_modules --exclude-dir=.git

# Vite / CRA / Nuxt
grep -rEn "(VITE_|REACT_APP_|NUXT_PUBLIC_|PUBLIC_).*(SECRET|KEY|PASSWORD|SERVICE_ROLE|ADMIN|TOKEN)" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.env*" \
  --exclude-dir=node_modules --exclude-dir=.git

# Логирование секретов
grep -rEn "(console\\.log|logger\\.|print|log\\.).*?(token|password|secret|key|credential|authorization)" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" \
  --exclude-dir=node_modules --exclude-dir=.git

# Source maps в production
grep -rEn "sourceMappingURL|productionBrowserSourceMaps|build.*sourcemap|devtool" \
  --include="*.js" --include="*.ts" --include="*.mjs" --include="*.config.*" \
  --exclude-dir=node_modules

# .env в git (текущее состояние)
git ls-files | grep -E "\\.env$|\\.env\\.local$|\\.env\\.production$|\\.env\\.staging$"

# .npmignore / package.json files field для публикуемых пакетов
ls -la .npmignore 2>/dev/null
cat package.json | grep -A5 "\"files\""
```

## Классификация

| Находка | Severity |
|---|---|
| Service role key / admin key в клиентском коде или публичной env-переменной | Critical |
| API key в git-истории (не ротирован) | Critical |
| Private key в репозитории | Critical |
| `.env.production` был когда-либо закоммичен | Critical |
| Source maps в production на публично доступном URL с чувствительным кодом | High |
| Секрет в `.env.example` с реальным значением | High |
| NEXT_PUBLIC_ / VITE_ / REACT_APP_ с чувствительным ключом | High |
| Long-lived AWS / GCP / Azure keys в CI (вместо workload identity) | High |
| Inline secrets в CI/CD workflow | High |
| Логирование authorization headers / tokens | Medium |
| `.env` не в `.gitignore` (но не закоммичен) | Medium |
| Плейсхолдеры в `.env.example`, похожие на реальные секреты | Low |
