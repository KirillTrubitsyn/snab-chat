# Hotspot-анализ

## Что проверять

Hotspot — это файл/модуль, который одновременно: (а) сложный (высокая цикломатика / размер / низкое code health), (б) часто меняется (высокая частота коммитов). Это именно тот код, где рефакторинг даст максимальный ROI. Сложный, но не меняющийся — работает и не беспокоит. Часто меняющийся, но простой — не проблема. А вот пересечение обоих — источник багов и замедления команды.

Метод предложил Адам Торнхилл («Your Code as a Crime Scene»).

## Как считать

### Способ 1. Вручную через git log

```bash
# Частота изменений каждого файла за последний год
git log --since="1 year ago" --name-only --pretty=format: \
  | grep -E "\.(ts|tsx|js|jsx|py|go|rs)$" \
  | sort | uniq -c | sort -rn | head -30

# Или за всю историю
git log --name-only --pretty=format: \
  | grep -E "\.(ts|tsx|js|jsx)$" \
  | sort | uniq -c | sort -rn | head -30
```

Дальше для каждого топа по частоте — измерь сложность:

```bash
# Размер
wc -l <top-file>

# Цикломатическая сложность (JS/TS)
npx eslint --rule 'complexity: ["error", 0]' <top-file> 2>&1 | grep "complexity"

# Cognitive complexity — через SonarJS или аналог
```

Пересечение «топ по частоте» ∩ «топ по сложности» = ваши hotspots.

### Способ 2. Script: combined hotspot score

```bash
#!/usr/bin/env bash
# hotspots.sh — простая оценка
set -e

# 1. Частота изменений
git log --since="1 year ago" --name-only --pretty=format: \
  | grep -E "\.(ts|tsx|js|jsx)$" \
  | sort | uniq -c | sort -rn > /tmp/churn.txt

# 2. Сложность (размер как прокси)
while read -r line; do
  churn=$(echo "$line" | awk '{print $1}')
  file=$(echo "$line" | awk '{print $2}')
  if [[ -f "$file" ]]; then
    loc=$(wc -l < "$file")
    score=$((churn * loc))
    echo "$score $churn $loc $file"
  fi
done < /tmp/churn.txt | sort -rn | head -20
```

Даёт список: `<score> <churn> <loc> <file>`. Топ = hotspots.

### Способ 3. CodeScene

Профессиональный инструмент Тhorhill'а. Считает:

- **Code Health** (1-10): композитная метрика из cyclomatic, cognitive, nesting, arg count, length.
- **Change frequency**.
- **Hotspots**: пересечение Code Health < 7 и high change frequency.
- **Complexity trends**: растёт или падает сложность со временем.
- **Temporal coupling**: файлы, которые меняются вместе (признак скрытых зависимостей).
- **Knowledge map**: кто «владеет» файлом (для code review).

Есть бесплатный тариф для open source и pilot-версия. MCP-интеграция позволяет AI-ассистенту запрашивать hotspot-данные напрямую.

### Способ 4. git-hotspots (open source)

```bash
npx git-hotspots --since "6 months ago" --extensions ts,tsx
```

## Temporal coupling

Отдельная ценная метрика: файлы, которые всегда меняются вместе, хотя формально не связаны.

```bash
# Упрощённо: найди коммиты, где 2+ файла меняются вместе
git log --pretty=format:"COMMIT %H" --name-only \
  | awk '/^COMMIT/ {commit=$2; next} $0 {files[$0]=files[$0]" "commit}' \
  | ...
```

Temporal coupling без explicit import — смысловая связь, потерянная в коде. Часто это feature, размазанная по слоям.

**Рефакторинг**: перегруппировать, чтобы файлы, меняющиеся вместе, лежали рядом (feature-sliced architecture).

## Что делать с hotspot

Стандартный протокол:

1. **Зафиксируй hotspot** в отчёте с метриками.
2. **Проанализируй причину**: почему часто меняется? Продуктовая фича растёт? Плохой дизайн вынуждает править каждый раз? Баги?
3. **Оцени safety net** (см. `safety-net.md`).
4. **Выбери стратегию**:
   - Small refactoring (Extract Function, Rename) — если причина в локальной сложности.
   - Branch by abstraction — если нужна крупная замена.
   - Strangler fig — если hotspot уже «God-класс», который проще обойти, чем починить.
5. **Рефактори инкрементально**. Первая цель — снизить code health до приемлемого, чтобы следующие изменения были дешевле.

## Антипаттерны работы с hotspot

- **Переписать с нуля**: обычно кончается вторым hotspot'ом с теми же проблемами.
- **Не трогать, потому что страшно**: цена невнимания растёт экспоненциально.
- **Рефактор в отрыве от изменений продукта**: рефакторь тогда, когда в этот модуль и так нужно вносить изменения. Это даёт естественный safety net (ревью и тесты — для фичи, заодно и за рефакторинг).

## Когда hotspot — не проблема

- Файл действительно «живой» домен: бизнес-логика часто меняется и это нормально, если структура хорошая.
- Сгенерированный код (Prisma client, GraphQL codegen) — меняется часто, но не пишется вручную.
- Конфиг (i18n-файлы, feature flags) — частые изменения, низкая сложность, не требует рефакторинга.

Отфильтруй такие случаи перед финальным списком.

## Ссылки

- Adam Tornhill. *Your Code as a Crime Scene*, 2nd ed.
- Adam Tornhill. *Software Design X-Rays*.
- CodeScene documentation: [https://codescene.io](https://codescene.io).
