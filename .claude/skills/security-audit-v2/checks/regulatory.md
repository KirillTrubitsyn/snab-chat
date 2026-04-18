# Regulatory compliance

Этот модуль маппит технические находки на требования актуальных регуляций. С августа 2026 года большая часть EU AI Act вступает в силу, с июня 2026 — conformity assessment под EU Cyber Resilience Act, с сентября 2026 — incident reporting под CRA. Любой AI-аудит или аудит продукта для EU-рынка с этих дат должен включать compliance-секцию.

Применяй этот модуль для продуктов с EU-экспозицией (данные граждан ЕС, сервисы на EU-рынке), для AI-систем (любой scope), для российских компаний с PII-обработкой (152-ФЗ).

## Что проверять

### 1. EU AI Act (ключевые даты)

**2 августа 2026**: вступают в силу большинство положений, включая:
- Article 50 (transparency): обязательная маркировка AI-generated content.
- High-risk AI systems: conformity assessment, risk management, data governance, human oversight, technical documentation.
- GPAI supervision: полная активация надзора AI Office над general-purpose AI models.
- AI Sandboxes: Member States должны иметь operational AI sandboxes.

**2 августа 2027**: Article 6(1) (high-risk classification) для pre-existing systems public authorities.
**2 августа 2030**: compliance deadline для legacy high-risk systems, используемых public authorities.

Вопросы аудитора:
- Классифицируется ли система как high-risk по Annex III AI Act? (Области: biometric ID, critical infrastructure, education, employment, essential services, law enforcement, migration, justice.)
- Если high-risk: есть ли conformity assessment? Technical documentation? Risk management system? Data governance процесс? Human oversight requirements? Logging & monitoring для post-market surveillance?
- Если используется GPAI (foundation model через API): известны ли model card и documentation от провайдера? Если собственный fine-tuned — есть ли документация рисков?
- Article 50 transparency: маркируется ли AI-generated контент как таковой в пользовательском UI?
- Зарегистрирована ли система в EU database для high-risk systems?

### 2. EU Cyber Resilience Act (CRA)

Применяется к продуктам с digital elements (software, IoT, AI-продукты, browser extensions, и т. д.) на EU-рынке.

**11 июня 2026**: активируются conformity assessment bodies.
**11 сентября 2026**: обязательное incident и vulnerability reporting (24–72 часа в ENISA / CSIRT).
**11 декабря 2027**: полные требования для новых продуктов.

Категории продуктов и уровень assessment:

| Категория | Примеры | Assessment |
|---|---|---|
| Default | Consumer IoT, USB peripherals | Self-assessment |
| Important Class I | Browsers, antivirus, password managers | Harmonised standards / third-party |
| Important Class II | Firewalls, IDS/IPS, secure elements | Mandatory third-party (notified body) |
| Critical | HSMs, smart meters, smart cards | EUCC scheme |

Вопросы аудитора:
- Продукт подпадает под CRA scope? (Практически всё commercial software с EU customers.)
- Есть ли SBOM в формате SPDX 2.3+ или CycloneDX 1.5+ в technical documentation?
- Есть ли vulnerability disclosure policy в соответствии с ISO/IEC 29147 и ISO/IEC 30111?
- Подготовлен ли 24-часовой notification pipeline для exploited vulnerabilities и incidents?
- Security by design evidence: threat modeling, secure coding practices, secure defaults.
- Post-market vulnerability handling: автоматические security updates, transparent patch process.
- Duration of support: как долго будет обеспечиваться security support? Обычно 5 лет или expected product lifetime.
- CE marking для cybersecurity extended: присутствует ли?

### 3. NIS2 Directive

Применяется к essential и important entities в критичных секторах (energy, transport, banking, healthcare, digital infrastructure, public administration, и т. д.). Активно enforced с конца 2024 года.

Вопросы аудитора:
- Entity covered? (Критерий: size + sector от Annex I/II.)
- Registered в national authority?
- Incident reporting готовность: 24-час early warning → 72-час notification → 1-месячный detailed report.
- Технические меры: risk analyses, cryptography policies, supply chain security, vulnerability handling, cyber hygiene training.
- Executive accountability: management board нанесёт персональную ответственность за cybersecurity governance.
- Supply chain: проведён ли security assessment ключевых suppliers?

### 4. GDPR и 152-ФЗ (Россия)

**GDPR** — применяется к обработке PII граждан ЕС независимо от локации сервиса.

Вопросы аудитора:
- Data processing records (ROPA) ведутся?
- Privacy by design в архитектуре? Data minimization — хранится ли минимум необходимого?
- Consent management: явное, revocable, documented?
- Data subject rights: реализованы ли DSAR, right to deletion, data portability?
- PII в логах — минимизируется / redacted?
- Cross-border transfers: есть ли SCC / adequacy decision / BCR для передачи в non-adequate countries?
- Breach notification: 72-часовой pipeline в supervisory authority?
- DPIA для high-risk processing (включая AI-системы для высокорискового решения о людях)?

**152-ФЗ** — для российских операторов PII:
- Локализация ПД граждан РФ: первичная запись в БД на территории РФ.
- Роскомнадзор registration: уведомление об обработке подано?
- Классификация ПД: общие, специальные, биометрические, иные — с разными требованиями к защите.
- Модель угроз и уровень защищённости (УЗ-1…УЗ-4) определён?
- Соответствие требованиям ФСТЭК (Приказ №21 для ИСПДн).
- Trans-border transfers: уведомление в Роскомнадзор по 242-ФЗ.
- Обработка ПД работников: согласия, ЛНА.
- Retention и destruction: сроки хранения, акты уничтожения.

Изменения 2024–2025 годов:
- С 1 сентября 2022 (ФЗ-266) ужесточена ответственность за утечки.
- С 30 мая 2025 — административная ответственность усилена (КоАП 13.11 — штрафы до 3% оборота для повторных).
- Уголовная ответственность (УК 272.1) за утечки ПД с марта 2025.

### 5. AI-specific regulatory (помимо EU AI Act)

- **US Executive Orders на AI** (динамично меняются, уточняй актуальный статус).
- **UK AI Safety Institute** guidelines для foundation models.
- **Китайские правила** для Generative AI services (Interim Measures 2023) — если пользователи в Китае.
- **NIST AI RMF** — не обязательно, но industry standard для framework compliance.

### 6. Industry-specific

- **PCI DSS 4.0** (с марта 2024 обязательно): любая обработка card data.
- **HIPAA**: PHI в US.
- **SOC 2 Type II**: часто требуют enterprise customers.
- **ISO 27001 / 27701**: information security + privacy.

## Как искать в коде (косвенные индикаторы)

```bash
# Cookies consent / GDPR banner
grep -rn "cookieconsent\|gdpr\|CookieBanner\|onetrust" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"

# AI-generated content markers
grep -rn "AI-generated\|generated by AI\|ai_marker\|aigc" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"

# Privacy policy, DPA
find . -iname "privacy*" -o -iname "gdpr*" -o -iname "*dpa*.md" -o -iname "*terms*.md"

# Data subject rights endpoints
grep -rn "data-export\|data-deletion\|dsar\|right-to-forget" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# PII retention / deletion
grep -rn "retention\|ttl.*user\|deletion_date\|anonymize\|pseudonymize" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# Regional data residency
grep -rn "region.*EU\|region.*RU\|data_residency\|data_region" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.env"
```

## Классификация

| Находка | Severity |
|---|---|
| High-risk AI system без conformity assessment (после 2 августа 2026) | Critical |
| Отсутствие breach notification pipeline для CRA/GDPR/NIS2 | Critical |
| Нет SBOM у продукта под CRA scope (после декабря 2027) | Critical |
| ПД граждан РФ хранятся только за границей (152-ФЗ) | Critical |
| Нет DPIA для AI-системы с high-risk processing | High |
| Logging включает PII без redaction / минимизации | High |
| Нет data subject rights UI (export, delete) | High |
| Отсутствует transparency-маркировка AI output (Article 50) | High |
| Cross-border transfer без SCC / adequacy | Medium |
| Нет retention policy | Medium |
| Нет cookies consent banner для EU-traffic | Medium |
| Privacy policy устарела | Low |
