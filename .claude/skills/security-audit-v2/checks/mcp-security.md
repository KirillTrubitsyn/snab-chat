# MCP (Model Context Protocol) Security

Применяй этот модуль, если проект использует MCP-серверы (Anthropic MCP, Claude Desktop, Cursor, клиенты через `mcp-remote`, собственные серверы на `@modelcontextprotocol/sdk` или `fastmcp`). MCP за 2025–2026 год стал массовой поверхностью атаки: тулз-пойзонинг, rug pull, command injection в tool handlers, cross-tenant утечки, RCE через OAuth-прокси. Основные публичные инциденты: CVE-2025-6514 (mcp-remote RCE, CVSS 9.6), CVE-2025-68143 / 68144 / 68145 (цепочка в Anthropic mcp-server-git → RCE через `.git/config`), инцидент Asana MCP (cross-tenant leak), GitHub MCP (exfiltration через over-privileged PAT), системная уязвимость MCP 15 апреля 2026 (Ox Security, 150M+ загрузок).

## Что проверять

### 1. Tool poisoning и rug pull

MCP-серверы могут менять определения tools между сессиями. Пользователь одобряет tool на день 1, через неделю тот же tool тихо переправляет API-ключи атакующему.

- Есть ли пиннинг версий MCP-серверов? Конфигурация клиента должна содержать конкретную версию или SHA, не `latest`. Проверь `mcp.json`, `claude_desktop_config.json`, `.cursor/mcp.json`.
- Есть ли allowlist tools? Даже если сервер предлагает 20 tools, в конфигурации клиента должен быть явный список разрешённых.
- Детектируются ли изменения tool definitions? При подключении к серверу должен вычисляться хэш от списка tools и сравниваться с предыдущим — при расхождении запрашивать повторное согласие пользователя.
- Есть ли cryptographic server verification при cloud-hosted MCP? Клиент должен проверять сертификат сервера, а не доверять hostname.

### 2. Command injection и RCE в tool handlers

Если проект содержит собственный MCP-сервер, проверь все tool handlers на классические injection-уязвимости. В 2025–2026 году именно это — основной класс RCE в MCP.

- Аргументы, передаваемые в `exec`, `child_process.spawn`, `subprocess.run`, `os.system` — санитизированы ли они? Не используется ли `shell=True`?
- Пути файлов из аргументов — проверяются ли на `..`, absolute paths, null bytes, case-sensitivity bypass (инцидент Cursor с `.cursor/mcp.json` через case-insensitive FS)?
- Git-операции: передача user input в `git clone`, `git diff`, `git init` — потенциальный argument injection (паттерн CVE-2025-68144). Передача git-URL, начинающихся с `--upload-pack=`, `--config=` — классический вектор RCE.
- SQL-tools: параметризация запросов, не конкатенация.
- URL fetching в tools: SSRF-защита (см. `api-surface.md` раздел 7).

### 3. Over-privileged tokens и credentials

Инцидент GitHub MCP и в целом кампания марта–апреля 2026 показали: широкие PAT + untrusted content в контексте LLM = автоматический exfiltration через легитимные tool calls.

- Какие scope у токенов, передаваемых в MCP-сервер? Должен быть минимальный набор: `repo:read` вместо `repo`, `issues:read` вместо `admin:org`.
- Используются ли **ephemeral credentials** с TTL минуты, а не long-lived tokens?
- Разделены ли identity для разных агентов? Один общий service account на все MCP-серверы — анти-паттерн.
- Применяется ли OAuth 2.0 Token Exchange (RFC 8693) для on-behalf-of делегирования, чтобы MCP-сервер действовал от имени пользователя с его правами, а не с правами сервиса?
- Передаются ли токены через `env`-переменные tool'а (ok), или через аргументы (попадут в логи процессов)?

### 4. Cross-tenant isolation

Для мультитенантных приложений с MCP-интеграциями это отдельный риск. Инцидент Asana MCP (июнь 2025) — данные одной организации стали видны другой из-за логической ошибки в access control MCP-feature.

- Для каждого tool, работающего с данными: откуда берётся tenant_id? Только из верифицированного контекста запроса, не из аргументов tool.
- Тест: пользователь tenant A → MCP tool с подставленным tenant_id = B → должен вернуть 403 или пустой результат, не данные B.
- Логирование tool calls должно быть scoped per-tenant.
- KMS-ключи и encryption at rest — per-tenant, не общие.

### 5. Authentication и транспорт

Спецификация MCP исторически слабо регламентирует auth, что приводит к разнородным и часто слабым реализациям.

- Session IDs в URL — **анти-паттерн**, но встречается в реализациях SSE-transport. Session ID должен быть в заголовке или cookie, не `GET /messages/?sessionId=UUID`.
- Message signing: подписаны ли сообщения между клиентом и сервером? Без подписи возможен MITM и tampering.
- HTTPS для всех remote MCP. Явно блокировать HTTP (CVE-2025-6514 эксплуатировалась при downgrade на HTTP).
- Для локальных MCP-серверов на HTTP transport: проверка защиты от DNS rebinding (инцидент Vet MCP, июль 2025). Сервер должен проверять заголовок `Host`, `Origin`, использовать случайный порт и auth token.
- `mcp-remote` как OAuth-прокси: версия ≥ 0.1.16 (фикс CVE-2025-6514). Версии 0.0.5–0.1.15 — критично.
- MCP Inspector в dev-режиме: не должен быть доступен на `0.0.0.0` без auth (был RCE через unauthenticated inspector).

### 6. Human-in-the-loop для destructive операций

Чисто автономный агент с write-доступом — основной вектор excessive agency (OWASP LLM06:2025).

- Определены ли категории destructive операций: write / delete / financial / admin / external-communication?
- Для каждой такой категории — mandatory approval gate: агент показывает preview, пользователь явно подтверждает.
- Пороги уверенности: операции ниже threshold уходят на human review.
- Логируется ли approver identity вместе с самим действием?
- Если операция irreversible (удаление, списание, публикация) — step-up auth через IdP.

### 7. Sandboxing и изоляция

- Локальные MCP-серверы: запущены ли в sandbox (container, chroot, macOS sandbox, Windows AppContainer)?
- Filesystem scope: MCP Filesystem сервер должен иметь явный allowlist директорий, не root FS.
- Network egress: MCP-сервер должен иметь ограниченный egress, блокируя доступ к internal services.
- Для HTTP transport — rate limiting per client.
- Рекомендация: MCP Gateway pattern (TrueFoundry, Docker MCP Gateway, MCP Manager) как единая точка с RBAC, rate limiting, audit logging.

### 8. Confused deputy и tool shadowing

- Когда подключены несколько MCP-серверов: не могут ли они иметь одинаковые или похожие имена tools? Tool shadowing — malicious server переопределяет легитимный tool.
- Валидируются ли имена tools по whitelist, или клиент просто берёт то, что сервер объявил?
- Validation input/output на MCP-слое: tool result от одного сервера не должен содержать инструкции, которые LLM интерпретирует как команду другому серверу (indirect prompt injection через tool result).
- Untrusted servers co-connected с trusted: могут ли они exfiltrate данные через shared agent context? Академическое исследование 67 057 MCP-серверов (октябрь 2025) показало массовость проблемы.

### 9. Dynamic client registration и OAuth-прокси

Относится к MCP-серверам, действующим как OAuth-прокси для сторонних API (static client ID + dynamic client registration).

- MCP proxy с static client ID + third-party authorization server, который ставит consent cookie после первой авторизации → атака "cookie confusion": второй клиент получает токены без consent.
- Для каждого MCP client должен быть отдельный per-client consent перед forwarding в upstream provider.
- Origin validation на MCP endpoint.

## Как искать в коде

```bash
# Конфигурация MCP-клиентов
find . -name "mcp.json" -o -name "claude_desktop_config.json" -path "*/.cursor/*" -name "*.json" 2>/dev/null
grep -rn "mcpServers\|mcp_servers" --include="*.json" --include="*.yaml" --include="*.yml"

# Собственные MCP-серверы: handlers, которые принимают user input
grep -rn "@server\.tool\|@mcp\.tool\|server\.setRequestHandler\|tool(\"" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py"

# Command execution в tool handlers
grep -rn "exec(\|execSync\|spawn(\|subprocess\.\|child_process\|os\.system\|shell=True" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py"

# mcp-remote версия
grep -rn "mcp-remote" --include="package.json" --include="*.json"
npm list mcp-remote 2>/dev/null

# Session IDs в URL (анти-паттерн)
grep -rn "sessionId=\|session_id=.*url\|?sid=" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py"

# OAuth flows в MCP
grep -rn "authorization_endpoint\|client_id.*static\|dynamic_registration\|oauth.*mcp" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py"

# DNS rebinding protection
grep -rn "Host.*header\|origin.*check\|validateHost\|127\.0\.0\.1" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py"

# Filesystem scope в MCP Filesystem-подобных серверах
grep -rn "allowedDirectories\|allowed_paths\|roots\[" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py"
```

## Классификация находок

| Находка | Severity |
|---|---|
| RCE через command injection в tool handler | Critical |
| mcp-remote версии 0.0.5–0.1.15 (CVE-2025-6514) | Critical |
| mcp-server-git версии до фикса CVE-2025-68143/68144/68145 | Critical |
| Long-lived admin token передаётся в MCP-сервер с untrusted content в контексте | Critical |
| Cross-tenant доступ через MCP tool | Critical |
| Отсутствие human-in-the-loop для destructive операций | High |
| Tool poisoning / отсутствие пиннинга версий | High |
| Session ID в URL на SSE transport | High |
| DNS rebinding-уязвимый локальный HTTP-сервер | High |
| Path traversal в tool handler | High |
| Нет hash-проверки tool definitions между сессиями | Medium |
| Общий service account на несколько MCP-серверов | Medium |
| Нет MCP Gateway, tools подключены напрямую | Medium |
| Нет allowlist tools в конфигурации клиента | Medium |
| MCP Inspector на 0.0.0.0 без auth в dev-окружении | Medium |

## Reference CVE и инциденты

| ID | Описание | Дата |
|---|---|---|
| CVE-2025-6514 | mcp-remote RCE через authorization_endpoint, CVSS 9.6 | июль 2025 |
| CVE-2025-68143 | mcp-server-git: unrestricted git_init, .ssh → git repo | 2025 |
| CVE-2025-68144 | mcp-server-git: argument injection в git_diff | 2025 |
| CVE-2025-68145 | mcp-server-git: path validation bypass | 2025 |
| CVE-2025-59528 | Flowise CustomMCP XSS → RCE | апрель 2026 |
| Ox Security MCP disclosure | Системная уязвимость MCP, 150M+ загрузок | 15 апреля 2026 |
| Asana MCP cross-tenant leak | Cross-tenant access через MCP-feature | июнь 2025 |
| GitHub MCP incident | Over-privileged PAT + untrusted issues → exfiltration | 2025 |
| Anthropic MCP Inspector RCE | Unauthenticated RCE через inspector-proxy | 2025 |
| Zen MCP path bypass | is_dangerous_path() exact-match bypass | 2025 |
| Kluster Verify MCP credit drain | Unauthorized tool access → financial DoS | 2025 |
| Cursor .cursor/mcp.json case bypass | Case-insensitive FS → malicious server injection | 2025 |
