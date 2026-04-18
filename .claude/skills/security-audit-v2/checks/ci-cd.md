# CI/CD Pipeline Security

Применяй этот модуль при наличии `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `cloudbuild.yaml` или аналогов.

Q1 2026 показал, что CI/CD — один из топ-векторов atак: campaign TeamPCP в марте использовала украденные CI-credentials для публикации компрометированных пакетов (LiteLLM, Telnyx, Axios).

## Что проверять

### 1. Injection через PR metadata

GitHub Actions уязвимы к injection, если workflow использует выражения `${{ github.event.pull_request.title }}`, `${{ github.event.issue.body }}`, `${{ github.event.comment.body }}` внутри `run:` блоков. Атакующий может создать PR с заголовком, содержащим shell-команды.

Безопасный паттерн: передавать значения через environment variables, а не inline:
```yaml
# Уязвимо
- run: echo "${{ github.event.pull_request.title }}"

# Безопасно
- run: echo "$PR_TITLE"
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
```

### 2. Secrets exposure

- Используются ли GitHub Secrets / GitLab CI Variables для секретов, или они захардкожены в workflow-файлах?
- Есть ли `echo` или логирование, которое может вывести секреты в лог?
- Проверь `actions/checkout` с `persist-credentials: true` (по умолчанию) — GITHUB_TOKEN доступен дочерним шагам.
- **pull_request_target** trigger с `actions/checkout` forked code — классический вектор секретов leak.
- **Environment secrets** vs **repository secrets**: sensitive workflow должны использовать environment-scoped secrets с approval gates.

### 3. Переход к OIDC / workload identity

Современный best practice 2026: **уходить от static long-lived credentials в CI**.

- **AWS**: `aws-actions/configure-aws-credentials` с `role-to-assume` и `permissions: id-token: write` — federated через OIDC, не AWS access keys в secrets.
- **GCP**: Workload Identity Federation.
- **Azure**: federated credentials for service principals.
- **Vercel / Cloudflare**: managed integration через GitHub App.
- **Docker / GHCR**: GITHUB_TOKEN для push в той же org, не separately provisioned PATs.

Long-lived access keys в CI — **High severity finding** с рекомендацией миграции.

### 4. Разрешения (permissions)

- Указаны ли `permissions` в workflow? Без явного указания используется default (обычно `write-all`), что избыточно.
- Используется ли принцип least privilege: `contents: read`, `pull-requests: write` и т. п.?
- Top-level `permissions: read-all`, с job-level override там, где нужно больше.

### 5. Third-party Actions

- Используются ли actions с пиннингом к SHA (`uses: actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29`) или к тегу (`uses: actions/checkout@v4`)? Теги мутабельны — автор может изменить, на что указывает тег.
- Есть ли actions из непроверенных источников (не `actions/*`, не `github/*`)?
- Dependabot configured для auto-update actions?

### 6. Branch Protection

- Настроены ли branch protection rules для main / master / release-*?
- Требуется ли PR review перед merge?
- Есть ли required status checks (тесты, линтер, SAST, dependency scan)?
- Запрещён ли force push в main?
- Signed commits требуются?
- Admin bypass отключён?

### 7. Deployment Security

- Автоматический деплой в production при push в main: есть ли approval step?
- Разделены ли окружения staging и production (different credentials, different cloud accounts)?
- Используются ли отдельные credentials для staging и production?
- Deployment approvals для production: required reviewers?
- Rollback capability протестирован?

### 8. Supply chain integrity

- **Sigstore cosign** для signing артефактов?
- **SLSA provenance** генерируется (slsa-github-generator action)?
- **SBOM** генерируется в CI и сохраняется как artifact?
- **Build provenance**: artifact attestation через `actions/attest-build-provenance`?

### 9. Secret scanning в CI

- **TruffleHog / Gitleaks / detect-secrets** запускаются на каждом PR?
- GitHub Secret Scanning включён (требует GHAS для private repos)?
- Push protection (блокировка коммита с секретом) включена?

### 10. SAST / DAST / Dependency scanning

- **Dependency scanning**: Dependabot / Renovate + `npm audit` / `pip-audit` в CI?
- **SAST**: CodeQL / Semgrep / Snyk / SonarCloud?
- **Container scanning**: Trivy / Grype / Snyk Container?
- **License scanning** (если важно compliance)?
- Gate на critical findings — блокируют ли merge?

### 11. Self-hosted runners

Если используются self-hosted runners:
- Ephemeral (one-shot) или persistent? Persistent — опаснее, исполняющиеся на shared runner steps могут оставлять artifacts / credentials.
- Network segmentation: runner имеет access только к тому, что ему нужно для job?
- Runner images: patched?

### 12. Webhooks и secrets

- Incoming webhooks (Slack, Discord notifications): signature verification?
- Outgoing webhooks: TLS, signed payloads?

## Как искать

```bash
# Workflow files
find . -path "*/.github/workflows/*.yml" -o -name ".gitlab-ci.yml" -o -name "Jenkinsfile" -o -name "bitbucket-pipelines.yml" -o -name "cloudbuild.yaml" 2>/dev/null

# Injection-уязвимые паттерны
grep -rEn "\\\$\\{\\{ *github\\.event\\.(pull_request|issue|comment|review)\\." --include="*.yml" --include="*.yaml" .github/ 2>/dev/null

# Inline secrets
grep -rEn "(password|token|secret|api_key|api-key): *[a-zA-Z0-9]{10,}" .github/workflows/ .gitlab-ci.yml 2>/dev/null

# Permissions
grep -rn "permissions:" .github/workflows/ 2>/dev/null

# Action pinning к тегам (менее безопасно) vs SHA
grep -rEn "uses: *[^@]+@v[0-9]" .github/workflows/ 2>/dev/null
grep -rEn "uses: *[^@]+@[a-f0-9]{40}" .github/workflows/ 2>/dev/null

# AWS long-lived keys (анти-паттерн)
grep -rEn "AWS_ACCESS_KEY_ID|aws-access-key-id" .github/workflows/ 2>/dev/null

# OIDC (позитивный паттерн)
grep -rn "id-token: write\|role-to-assume\|configure-aws-credentials" .github/workflows/ 2>/dev/null

# pull_request_target (опасный trigger)
grep -rn "pull_request_target" .github/workflows/ 2>/dev/null
```

## Классификация

| Находка | Severity |
|---|---|
| Injection через github.event в `run:` без env | Critical |
| Long-lived AWS/GCP/Azure credentials в CI secrets | High |
| Actions без SHA-pinning из непроверенных источников | High |
| pull_request_target с checkout forked кода + секрет доступ | High |
| permissions отсутствуют (default write-all) | Medium |
| Нет branch protection / signed commits | Medium |
| Нет SAST/dependency scan в CI | Medium |
| Нет SBOM generation | Medium |
| Нет Secret Scanning | Medium |
| Actions pinned к тегам, не SHA | Low |
