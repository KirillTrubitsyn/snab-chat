# Архитектурные smells

## Что проверять

Архитектурный долг — самый дорогой тип долга. Локальные smells исправляются за часы, архитектурные — за недели. Приоритет: обнаружить рано, документировать, планировать миграцию.

### 1. Нарушения модульных границ

Модули должны зависеть в одну сторону (нижние слои не знают о верхних).

**Признаки**:

- Циклические зависимости между модулями (`A → B → A`).
- Domain-слой импортирует UI-код.
- Data-слой (repository) импортирует use case.
- `utils/` / `shared/` импортирует фичи.

**Инструменты**:

- `madge --circular src/` — циклы в JS/TS.
- `dependency-cruiser` — правила-валидаторы зависимостей с запретами.
- `eslint-plugin-boundaries` — правила импортов в ESLint.
- `nx graph` — в Nx-монорепо.

**Рефакторинг**:

- Dependency Inversion: модуль определяет интерфейс, а не зависит от реализации.
- Разнеси по папкам с явными публичными API (`index.ts` или `public.ts`).
- В монорепо — явные пакеты с правилами импорта.

### 2. God Module / God Package

Папка `utils/` или `shared/` на 200 файлов — это не общий код, это свалка.

**Признаки**:

- `lib/utils.ts` содержит не связанные друг с другом функции.
- `types/` имеет типы из разных доменов вперемешку.
- Почти все файлы проекта импортируют из `shared/`.

**Рефакторинг**:

- Группируй по feature / bounded context. Feature-Sliced Design или layered architecture дают структуру.
- Общим оставляй только то, что действительно общее для всех features (форматтеры, i18n, базовые компоненты UI).
- Проверь cohesion: функции в одном файле должны иметь общую тему. Иначе — разнеси.

### 3. Отсутствие чётких границ feature/domain

Код размазан: логика одной фичи в 15 местах по папкам `components/`, `hooks/`, `services/`, `types/`, `api/`.

**Рефакторинг**: переход на **feature-sliced** или **колокацию**:

```
features/
  user-profile/
    ui/          # компоненты фичи
    model/       # состояние, бизнес-логика
    api/         # взаимодействие с API
    lib/         # вспомогательные чистые функции
    index.ts     # публичный API фичи
  checkout/
    ...
```

Правила:

- Фичи не импортируют друг друга напрямую. Если нужна кросс-feature зависимость — через shared-слой или композицию на уровне страницы.
- Внутри фичи можно импортировать что угодно; наружу видно только через `index.ts`.

### 4. Анемичный domain-слой

Business-logic размазан по контроллерам/роутам/компонентам, сущности — просто структуры данных с геттерами/сеттерами.

**Рефакторинг**: перенеси правила в доменные объекты:

```ts
// Smell
class OrderService {
  applyDiscount(order: Order, discount: number) {
    if (order.status === "shipped") throw new Error("Too late");
    if (discount > 50) throw new Error("Too much");
    order.total = order.total * (1 - discount / 100);
  }
}

// Лучше
class Order {
  applyDiscount(discount: Discount): void {
    if (this.status === OrderStatus.Shipped) throw new DomainError("Too late");
    this.total = discount.applyTo(this.total);
  }
}
```

### 5. Смешение слоёв

В один файл попадают: SQL-запросы, валидация, бизнес-правила, форматирование для UI, HTTP-респонс.

**Рефакторинг**:

- Минимум три слоя: Presentation (UI / API) → Application (use cases) → Domain (entities, value objects). Data access (repositories) — отдельно.
- Каждый слой знает только о слое ниже через интерфейс.

### 6. Shared-database antipattern в монолите, мигрирующем к сервисам

Если планируется микросервисный distill, но все модули пишут в одну базу напрямую — развалить такой монолит дорого.

**Рефакторинг**:

- Introduce repository per bounded context.
- Модули пишут только в свои таблицы, читают из других через API.
- Это подготовка к strangler fig на уровне сервисов.

### 7. Отсутствие ports & adapters (hexagonal)

Бизнес-логика хардкодит зависимости от БД, почты, внешних API. Юнит-тесты невозможны без mock-ов реальной БД.

**Рефакторинг**:

- Выдели интерфейсы для внешних зависимостей (`UserRepository`, `EmailSender`, `PaymentGateway`) в доменном слое.
- Реализации — в инфраструктурном слое.
- Use case принимает интерфейсы через DI (constructor injection, React context, passing-as-argument).
- Тесты используют in-memory реализации.

### 8. Монорепо без политики

Монорепо заявлено, но каждый пакет импортирует каждый, нет правил владения, CI пересобирает всё при любом изменении.

**Рефакторинг**:

- Явный граф зависимостей (Nx, Turborepo, Rush).
- Правила импортов (eslint-plugin-boundaries, dependency-cruiser).
- `CODEOWNERS` на уровне пакетов.
- Affected-билды в CI (только затронутые пакеты).

### 9. Микрофронтенды как решение проблемы, которой нет

Микрофронтенды — это про независимый deployment разных команд. Если команда одна — это overengineering.

**Рефакторинг**: модульный монолит. Раздели код по доменам, но разворачивай единым бандлом. Мигрируй к микрофронтендам только когда есть реальная мотивация: разные циклы релиза, разные технологии, команды с разным ritm'ом.

### 10. Отсутствие DI / сложность тестирования

Модули напрямую импортируют конкретные реализации → тесты требуют запуска всей инфраструктуры.

**Рефакторинг**:

- Constructor injection в классах.
- Function-level DI: функции принимают зависимости параметрами.
- В React: Context + provider; или passing as prop (для компонентов-границ).
- Простые случаи: фабричная функция, которую легко подменить в тестах.

### 11. Over-engineering для «будущих требований»

Множество слоёв абстракции «на вырост», которые никогда не используются.

**Признаки**:

- Repository-interface с одной реализацией, созданной в один день.
- Фабрики фабрик.
- Abstract classes с одним подклассом.
- DI-framework там, где хватит функций.

**Рефакторинг**: inline-ить обратно. YAGNI. Добавить абстракцию тогда, когда появился второй сценарий использования.

### 12. Бизнес-правила в базе данных (процедуры, триггеры)

Логика в триггерах / stored procedures — невидима для code review, не тестируется стандартными средствами, не типизируется.

**Рефакторинг**: постепенно выноси правила в application layer. Оставляй в БД только: целостность данных (FK, check constraints), производительность (агрегации), то, что физически быстрее делать в СУБД.

### 13. Отсутствие транзакционных границ

Изменения в нескольких местах без единой транзакции; полуобновлённое состояние при ошибке.

**Рефакторинг**: Unit of Work pattern; `BEGIN/COMMIT` явно на границе use case; saga-паттерн для распределённых случаев.

### 14. Глобальное состояние

Singletons, module-level `let`-переменные, global store с перемешанными доменами.

**Рефакторинг**: явные границы состояния; по feature — свой slice; внешние состояния (кэш, сессия) — через выделенные адаптеры.

## Как искать в коде

```bash
# Циклы зависимостей
npx madge --circular src/
npx madge --circular --extensions ts,tsx src/

# Dependency cruiser — отчёт
npx depcruise --config .dependency-cruiser.cjs src | less

# Размер папок (подозрительно большие — god packages)
find src -type d -exec sh -c 'echo $(find "$1" -type f | wc -l) "$1"' _ {} \; | sort -rn | head -20

# Какие файлы импортируются отовсюду (god modules)
grep -rhoE "from ['\"]([^'\"]+)['\"]" --include="*.{ts,tsx}" src/ | sort | uniq -c | sort -rn | head -30

# Глубина nested-папок (признак over-structure)
find src -type d | awk -F/ '{print NF-1}' | sort -n | uniq -c

# Статистика импортов по feature (cross-feature coupling)
for dir in src/features/*; do
  echo "=== $dir ==="
  grep -rn "from ['\"]@?/features/" "$dir" | grep -v "$(basename $dir)" | wc -l
done
```

## Инструменты для визуализации

- **madge** — циклические зависимости, граф.
- **dependency-cruiser** — мощный анализатор с правилами.
- **SonarQube / SonarCloud** — архитектурные метрики, cognitive complexity.
- **CodeScene** — behavioral code analysis, hotspots, team coupling.
- **Nx graph / Turbo graph** — для монорепо.
- **ArchUnit** (Java), **ts-arch** — тесты на архитектурные правила.

## Ссылки

- Martin Fowler: [Monolith First](https://martinfowler.com/bliki/MonolithFirst.html)
- Sam Newman: «Building Microservices», 2nd ed.
- Eric Evans: «Domain-Driven Design».
- Vaughn Vernon: «Implementing Domain-Driven Design».
- Adam Tornhill: «Your Code as a Crime Scene», 2nd ed.
