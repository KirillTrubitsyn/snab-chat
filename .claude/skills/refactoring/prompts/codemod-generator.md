# Промпт для генерации codemod

Используй, когда одна и та же механическая трансформация должна быть применена ко многим файлам. Результат промпта — готовый скрипт (ast-grep правило, ts-morph / jscodeshift / comby), который можно прогнать в dry-run, проверить, затем применить.

## Когда применять codemod (и когда нет)

Codemod уместен, если:

- Изменение чисто структурное (переименование, замена API, изменение импорта, обновление вызова).
- Количество точек применения > 10.
- Трансформация формализуема: «везде, где X, заменить на Y».
- Семантика каждого применения одинаковая.

Codemod НЕ уместен, если:

- Каждое применение требует осмысленного выбора (что оставить, что удалить).
- Изменение небольшое (< 10 мест — быстрее руками).
- Меняется бизнес-логика.
- Трансформация требует знания runtime-поведения, недоступного AST.

## Выбор инструмента

| Инструмент | Когда | Сильные стороны |
|---|---|---|
| **ast-grep** | Декларативные правила, большинство случаев | YAML-конфиг, быстрый, мультиязычный, простой |
| **ts-morph** | Сложные трансформации с переименованиями через весь проект | Богатый TypeScript API, учитывает typechecker |
| **jscodeshift** | Классические JS/React-миграции | Огромная экосистема готовых transforms |
| **comby** | Структурная замена с match-patterns, мультиязык | Простой синтаксис, работает вне специфики языка |
| **OpenRewrite** | Java/Kotlin/XML/YAML | Recipe-based, отличная поддержка enterprise-проектов |

## Шаблон промпта

```
ROLE
Ты выступаешь в роли engineer, пишущего codemod. Цель — создать скрипт, который применяет одну структурную трансформацию ко всем местам её появления в кодовой базе. Скрипт должен быть безопасным: dry-run сначала, полный diff перед применением, обратимость через git.

CONTEXT
Проект: <стек, например Next.js 15 + TS + Drizzle>
Корневая папка: <путь>
Область применения: <пути, где искать; пути, которые игнорировать>
Язык файлов: TypeScript + TSX
Инструмент: <ast-grep / ts-morph / jscodeshift / comby>

TRANSFORMATION
Опиши трансформацию как пару «до / после» на реальном репрезентативном примере из кода:

До:
```ts
<реальный фрагмент>
```

После:
```ts
<желаемый результат>
```

Если сценариев несколько (например, вариант с async и без) — приведи каждый вариант.

EDGE CASES
Перечисли случаи, которые похожи, но НЕ должны быть изменены:
- <пример 1: почему не трогаем>
- <пример 2: почему не трогаем>

OUTPUT REQUIREMENTS
1. Скрипт codemod в формате, совместимом с выбранным инструментом.
2. Пошаговая инструкция по запуску: сначала dry-run, затем полный прогон.
3. Команда проверки результата: tsc --noEmit + прогон тестов.
4. Список файлов, которые будут затронуты (сначала прогони поиск, покажи список перед генерацией самого скрипта).
5. Ожидаемое количество затрагиваемых мест.
6. Перечисли риски: что может пойти не так, как это проверить.

SAFETY
- Предпочитай декларативные правила (ast-grep) более сложному императивному коду.
- Если трансформация допускает варианты — предусмотри отдельное правило для каждого.
- Не генерируй rewrite, использующий string-replace по регуляркам поверх AST-инструмента.
- Если для отдельных случаев codemod применить нельзя — выдай их список отдельно для ручной обработки.

WORKFLOW
1. SEARCH. Покажи список совпадений по паттерну (до генерации самого правила).
2. PLAN. Опиши правило на человеческом языке; покажи 3-5 примеров до/после из реальных файлов.
3. AWAIT APPROVAL.
4. GENERATE. Сгенерируй скрипт.
5. DRY RUN. Покажи diff первых N файлов.
6. AWAIT APPROVAL.
7. FULL RUN. Применить + прогон тестов + tsc.
8. REPORT.

START
Начни с SEARCH.
```

## Примеры

### Пример 1. Замена устаревшего API React

Задача: заменить `React.FC<Props>` на типизацию через явные props.

До:
```tsx
const Button: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => {
  return <button onClick={onClick}>{label}</button>;
};
```

После:
```tsx
type ButtonProps = { label: string; onClick: () => void };
function Button({ label, onClick }: ButtonProps) {
  return <button onClick={onClick}>{label}</button>;
}
```

Правило в ast-grep (YAML):

```yaml
id: remove-react-fc
language: TypeScript
rule:
  pattern: |
    const $NAME: React.FC<$PROPS> = ($$$ARGS) => {
      $$$BODY
    }
fix: |
  type $NAME_Props = $PROPS;
  function $NAME($$$ARGS: $NAME_Props) {
    $$$BODY
  }
```

### Пример 2. Миграция импорта

Задача: заменить `import { useStore } from "old-lib"` на `import { useStore } from "@/stores"` во всей кодовой базе.

ast-grep правило:

```yaml
id: migrate-store-import
language: TypeScript
rule:
  pattern: import { $$$IMPORTS } from "old-lib"
fix: import { $$$IMPORTS } from "@/stores"
```

Или одной строкой ast-grep CLI:
```bash
ast-grep --pattern 'import { $$$A } from "old-lib"' \
         --rewrite 'import { $$$A } from "@/stores"' \
         --lang ts \
         --interactive
```

### Пример 3. Ts-morph для сложной трансформации

Когда нужно, например, обновить все вызовы функции, добавив новый обязательный параметр со значением по умолчанию.

```ts
import { Project, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "./tsconfig.json" });

for (const sourceFile of project.getSourceFiles()) {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getText() === "legacyCharge") {
      // Добавить параметр "currency: 'USD'", если его нет
      const args = call.getArguments();
      if (args.length === 2) {
        call.addArgument('"USD"');
      }
    }
  }
}

project.saveSync();
```

### Пример 4. Jscodeshift для миграции React-класс-компонентов

Готовые transforms в `react-codemod`:

```bash
npx react-codemod class-to-function src/
```

Для собственных transforms — аналогичная структура, детальный туториал на [github.com/facebook/jscodeshift](https://github.com/facebook/jscodeshift).

## Порядок безопасного применения

1. Прогон в отдельной ветке: `git checkout -b codemod/migrate-store-imports`.
2. Dry-run. Прочитай полный diff. Особенно внимательно — первые 10-20 файлов.
3. Full run. Коммит: `refactor: mechanical migration via ast-grep` с ссылкой на правило.
4. `pnpm tsc --noEmit` → должно быть зелёное.
5. Прогон всех тестов.
6. Проверка `knip` — не осталось ли мёртвых импортов после замены.
7. `biome format` (или `prettier --write`) в отдельном коммите.
8. PR с явным описанием: «mechanical refactor via codemod, no behavior change».

## Анти-паттерны

- **Codemod + правка руками в одном коммите**. Разделяй: сначала механическая трансформация, потом ручные доработки отдельным коммитом.
- **Codemod без прогона тестов**. Механические ошибки (пропущенный кейс, неправильный pattern) ловятся только тестами.
- **Codemod на чувствительном коде без review**. Auth, payments, критичные бизнес-правила — сначала human review каждого затронутого файла, даже если codemod выглядит безопасным.
- **Codemod через regex поверх AST-инструментов**. Если есть AST, используй AST. Regex ломается на edge cases.

## Ссылки

- ast-grep: [https://ast-grep.github.io/](https://ast-grep.github.io/).
- ts-morph: [https://ts-morph.com/](https://ts-morph.com/).
- jscodeshift: [https://github.com/facebook/jscodeshift](https://github.com/facebook/jscodeshift).
- comby: [https://comby.dev/](https://comby.dev/).
- OpenRewrite: [https://docs.openrewrite.org/](https://docs.openrewrite.org/).
- React codemod recipes: [https://github.com/reactjs/react-codemod](https://github.com/reactjs/react-codemod).
- Next.js codemods: `npx @next/codemod`.
