# Шаблон отчёта по аудиту безопасности

Используй эту структуру при формировании отчёта. Сохраняй отчёт в корне проекта как `security-audit-report-YYYY-MM-DD.md`.

---

```markdown
# Security Audit Report — [Название проекта]

**Дата аудита:** YYYY-MM-DD
**Аудитор:** Claude (security-audit skill)
**Версия скилла:** 2.0 (апрель 2026)
**Предыдущий аудит:** [дата или «первичный аудит»]

---

## A. Executive Summary

**Общий уровень риска:** [Critical / High / Medium / Low]

**Composite risk score:** X (= Critical × 10 + High × 5 + Medium × 2 + Low × 1)

| Severity | Количество |
|---|---|
| Critical | X |
| High | X |
| Medium | X |
| Low | X |
| Info | X |

**Ключевые выводы (3–5 пунктов):**
- [Главное, что нужно знать руководству за 30 секунд]

**Блокирует production:**
[Краткое перечисление Critical и High находок, которые необходимо устранить до выпуска. Если таких нет — указать «Production-ready с оговорками» или «Production-ready».]

**Regulatory-критичные находки:**
[Отдельно перечислить находки, создающие compliance-риски под EU AI Act / CRA / NIS2 / GDPR / 152-ФЗ. Если таких нет — «Не обнаружено».]

---

## B. Scope аудита

**Что проверялось:**
- [Компоненты, модули, окружения]
- [Применённые модули checks/]

**Что НЕ проверялось:**
- [Прямо указать исключения: не проверяли инфраструктуру облака, не проверяли бинарные артефакты, не делали network pentest и т. п.]

**Assumptions:**
- [Что принималось на веру: «файлы конфигурации production совпадают с git», «list of environment variables полный», и т. п.]

**Инструменты:**
- [Что использовалось: grep, npm audit, git log, перечень SAST-инструментов, если применялись]

**Методология:**
- OWASP Top 10:2025 для веб-приложений
- OWASP LLM Top 10:2025 для AI-компонентов
- OWASP GenAI Exploit Round-up Report Q1 2026
- [Дополнительные frameworks, если применимо]

---

## C. Обнаруженный стек

| Компонент | Технология |
|---|---|
| Фреймворк | [Next.js 14 / Express 4 / Django 5 / ...] |
| Язык | [TypeScript / Python / Go / ...] |
| БД | [Supabase PostgreSQL / PlanetScale / MongoDB / ...] |
| ORM | [Prisma / Drizzle / SQLAlchemy / ...] |
| Деплой | [Vercel / Railway / Fly.io / Docker / Kubernetes / ...] |
| CI/CD | [GitHub Actions / GitLab CI / ...] |
| Auth | [Supabase Auth / NextAuth / Clerk / Passkeys / custom / ...] |
| AI/LLM | [OpenAI / Anthropic / Google / xAI / локальные модели / нет] |
| Vector DB | [Pinecone / Weaviate / pgvector / Qdrant / нет] |
| MCP | [собственный сервер / используется клиент / нет] |
| Monitoring | [Sentry / Datadog / ...] |

---

## D. Таблица уязвимостей

| ID | Severity | CWE | OWASP | Компонент | Описание | Impact | Effort |
|---|---|---|---|---|---|---|---|
| SEC-001 | Critical | CWE-XXX | A0X:2025 | [файл/модуль] | [краткое описание] | [что может произойти] | S/M/L |
| SEC-002 | High | CWE-XXX | LLM0X:2025 | [файл/модуль] | [краткое описание] | [что может произойти] | S/M/L |

---

## E. Положительные находки

Что сделано правильно. Этот раздел важен — отчёт только с критикой демотивирует команду и даёт искажённую картину уровня зрелости.

- [✓ RLS включён на всех таблицах Supabase, политики scoped по auth.uid()]
- [✓ Секреты вынесены в environment variables, hardcoded credentials не обнаружены]
- [✓ CSP настроена с nonce, без unsafe-inline]
- [✓ Зависимости обновлены, 0 known-CVE в production-deps]
- [✓ CI использует OIDC federation вместо long-lived AWS keys]

---

## F. Детальный разбор

### SEC-001: [Название уязвимости]

**Severity:** Critical
**CWE:** CWE-XXX — [название]
**OWASP:** A0X:2025 — [название категории]
**Файл:** `path/to/file.ts`, строки XX–YY

**Описание:**
[Почему это уязвимость. Конкретно, без воды. Если архитектурный дефект — описать через data flow и trust boundary violation.]

**Exploit-сценарий:**
1. Атакующий делает X
2. Система отвечает Y
3. Результат: Z

**Рекомендация:**
[Что именно изменить. Конкретный файл, конкретное изменение.]

**Пример патча:**
```diff
- [уязвимый код]
+ [безопасный код]
```

**Compensating control (если фикс до релиза невозможен):**
[Временный митигейт, который снижает риск до исправления в коде. Например: «WAF-правило в Cloudflare, блокирующее pattern X», «feature flag, отключающий уязвимый endpoint», «ограничение доступа на уровне VPC».]

**Regulatory impact (если применимо):**
[Например: «GDPR Article 32 — adequacy of security measures», «EU AI Act Annex III high-risk system requirement», «152-ФЗ ст. 19 — обязанность по обеспечению безопасности».]

---

[Повторить для каждой находки]

---

## G. Проверка секретов

**Что проверялось:**
- Рабочее дерево: [да/нет]
- Git-история (все ветки): [да/нет]
- Env-файлы: [да/нет]
- Документация (README, docs): [да/нет]
- CI/CD конфиги: [да/нет]
- Публичные bundles / source maps: [да/нет]
- npm / PyPI / GitHub published packages: [да/нет]

**Найдено:**
| Тип | Расположение | Действие |
|---|---|---|
| [API key / token / password] | [файл:строка] | [ротировать / удалить / перенести в secrets] |

**False positives:**
[Что выглядит как секрет, но таковым не является: тестовые ключи, плейсхолдеры, примеры.]

**Требуется немедленная ротация:**
[Список ключей, которые уже могли утечь и должны быть заменены в первые 24 часа. Priority: ключи, которые попадали в git history, в public bundles, в logs.]

**Рекомендация по workload identity:**
[Если используются long-lived credentials в CI — рекомендация миграции на OIDC federation / workload identity.]

---

## H. Карта эндпоинтов

| Метод | Путь | Уровень защиты | Валидация входа | BOLA check | Rate limit | Проблемы |
|---|---|---|---|---|---|---|
| GET | /api/users | auth | zod schema | ✓ | ✓ | — |
| POST | /api/upload | auth | нет schema | n/a | ✓ | SEC-003: нет валидации MIME |
| DELETE | /api/items/:id | auth | — | ✗ | ✓ | SEC-004: нет ownership check (BOLA) |
| GET | /api/health | public | — | n/a | ✓ | OK (допустимо) |

---

## I. Regulatory mapping

Если продукт имеет EU-экспозицию, обрабатывает PII граждан РФ, или содержит AI-компоненты — заполнить эту секцию.

### EU AI Act (актуально с 2 августа 2026)

| Требование | Статус | Связанные находки |
|---|---|---|
| High-risk AI classification (Annex III) | [yes / no / N/A] | — |
| Conformity assessment | [compliant / gap] | SEC-XXX |
| Risk management system | [compliant / gap] | — |
| Human oversight | [compliant / gap] | SEC-XXX |
| Technical documentation | [compliant / gap] | — |
| Article 50 transparency (AI content marking) | [compliant / gap] | SEC-XXX |
| GPAI provider obligations | [applicable / N/A] | — |

### EU Cyber Resilience Act (CRA)

| Требование | Статус | Связанные находки |
|---|---|---|
| Product category | [Default / Important I / Important II / Critical] | — |
| SBOM generation | [compliant / gap] | SEC-XXX |
| Vulnerability disclosure policy (ISO 29147/30111) | [compliant / gap] | — |
| 24-h incident reporting pipeline | [compliant / gap] | SEC-XXX |
| Security by design evidence | [compliant / gap] | — |

### NIS2 (если covered entity)

| Требование | Статус | Связанные находки |
|---|---|---|
| Registration в national authority | [yes / no] | — |
| Incident reporting capability | [compliant / gap] | SEC-XXX |
| Risk management measures | [compliant / gap] | — |
| Supply chain security | [compliant / gap] | SEC-XXX |

### GDPR / 152-ФЗ

| Требование | Статус | Связанные находки |
|---|---|---|
| Data minimization | [compliant / gap] | SEC-XXX |
| PII в логах | [clean / contaminated] | SEC-XXX |
| DSAR / right to deletion | [implemented / gap] | — |
| Breach notification pipeline | [ready / gap] | — |
| 152-ФЗ локализация ПД РФ | [compliant / gap / N/A] | — |
| Cross-border transfers | [compliant / gap / N/A] | — |

---

## J. Production Hardening Plan

### P0 — до релиза (блокирующие)

| # | Задача | Владелец | ETA | Compensating control | Критерий завершения |
|---|---|---|---|---|---|
| 1 | [Описание] | Backend / DevOps / Sec | [срок] | [временный митигейт до фикса] | [как проверить] |

### P1 — первые 1–2 спринта

| # | Задача | Владелец | ETA | Compensating control | Критерий завершения |
|---|---|---|---|---|---|

### P2 — регулярный процесс

| # | Задача | Владелец | Частота | Критерий завершения |
|---|---|---|---|---|
| 1 | Ротация API keys | DevOps | 90 дней | Все ключи обновлены, старые отозваны |
| 2 | `npm audit` / `pip-audit` / `cargo audit` | CI | Каждый PR | 0 Critical/High в production deps |
| 3 | Dependency update | Backend | Ежемесячно | Все зависимости в пределах 1 major version |
| 4 | SBOM generation | CI | Каждый release | SBOM хранится как release artifact |
| 5 | Миграция на workload identity | DevOps / Sec | Q3 2026 | Long-lived credentials заменены на OIDC |
| 6 | Повторный security audit | Sec | Ежеквартально | Composite risk score уменьшается |

---

## K. Delta с предыдущим аудитом

[Этот раздел заполняется только при повторном аудите. При первичном аудите указать: «Первичный аудит, delta отсутствует.»]

### Сравнение composite risk score

| Метрика | Предыдущий аудит | Текущий аудит | Изменение |
|---|---|---|---|
| Critical | X | Y | ±Z |
| High | X | Y | ±Z |
| Medium | X | Y | ±Z |
| Low | X | Y | ±Z |
| **Composite score** | X | Y | **±Z%** |

### Исправленные находки
| ID | Описание | Дата закрытия |
|---|---|---|

### Новые находки (появились после предыдущего аудита)
| ID | Severity | Описание |
|---|---|---|

### Неизменённые находки (остались открытыми)
| ID | Severity | Описание | Причина |
|---|---|---|---|

### Тренд
[Общее направление: улучшение / стагнация / деградация. Количественное сравнение: composite score снизился с X до Y (-Z%), что соответствует [оценка].]
```
