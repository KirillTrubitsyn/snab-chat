# Классические code smells (Fowler) — актуализированная версия

## Что проверять

Это базовая таксономия Мартина Фаулера из книги «Refactoring» (2-е издание, 2018) с учётом практики 2025–2026. Применима к любому языку.

### Bloaters — код «раздувается»

#### 1. Long Method / Long Function

Функция длиннее 20 строк — подозрительно. Длиннее 50 — почти всегда smell. Знаки: комментарии с заголовками секций («// validation», «// main logic»), множественные уровни вложенности, несколько несвязанных ответственностей.

**Рефакторинг**: Extract Function. Начинай с выделения самых очевидных блоков (например, помеченных комментариями).

#### 2. Large Class

Класс с более чем 10 публичными методами или 7 полями — подозрительно. Знаки: в имени есть «Manager», «Service», «Controller», «Helper», «Utils» без уточнения домена.

**Рефакторинг**: Extract Class по признаку cohesion (какие поля используются какими методами вместе). Extract Subclass для полиморфного разделения.

#### 3. Primitive Obsession

Передача group of primitives вместо объекта: `function createUser(firstName: string, lastName: string, email: string, age: number, countryCode: string)`. Каждая пара «связанных» примитивов — кандидат на объект-значение.

**Рефакторинг**: Introduce Parameter Object. Для валидируемых значений — паттерн value object с приватным конструктором + фабрикой.

#### 4. Long Parameter List

Более 3–4 параметров — повод задуматься. Более 6 — почти всегда smell.

**Рефакторинг**: Introduce Parameter Object; Preserve Whole Object (передать объект целиком вместо его полей); Remove Flag Argument (boolean-параметр → два метода).

#### 5. Data Clumps

Одна и та же группа полей появляется в разных местах: `{ street, city, zip }` в пяти разных структурах. Значит, есть неявный объект.

**Рефакторинг**: Extract Class.

### Object-Orientation Abusers

#### 6. Switch Statements / Repeated Conditionals

`switch` или `if-else-if` по типу — почти всегда пропущенный полиморфизм. Особенно если тот же switch повторяется в нескольких местах.

**Рефакторинг**: Replace Conditional with Polymorphism; Replace Type Code with Subclasses; в функциональных языках — discriminated union + exhaustive check.

В TypeScript современная альтернатива — discriminated union с `never`-check:

```ts
type Action =
  | { type: "create"; payload: CreateInput }
  | { type: "update"; payload: UpdateInput };

function handle(a: Action): void {
  switch (a.type) {
    case "create": return createHandler(a.payload);
    case "update": return updateHandler(a.payload);
    default: {
      const _exhaustive: never = a;
      throw new Error(`Unhandled action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
```

#### 7. Temporary Field

Поле класса, используемое только в некоторых методах или только при определённых условиях. Обычно — результат выделения большого метода, где не выделили объект.

**Рефакторинг**: Extract Class (создать класс, где это поле всегда нужно).

#### 8. Refused Bequest

Подкласс переопределяет большую часть методов родителя или выбрасывает `NotImplementedError`. Наследование использовано ради переиспользования, а не по «is-a».

**Рефакторинг**: Replace Inheritance with Delegation.

### Change Preventers — мешают изменениям

#### 9. Divergent Change

Один модуль меняется по разным причинам (сегодня — меняется валидация, завтра — форматирование, послезавтра — БД). Нарушение SRP.

**Рефакторинг**: Split Phase; Extract Class.

#### 10. Shotgun Surgery

Одно изменение требует правок в десятке файлов. Противоположно Divergent Change: логика размазана.

**Рефакторинг**: Move Function / Move Field, чтобы собрать логику в одном месте. Иногда Inline перед повторным Extract.

#### 11. Parallel Inheritance Hierarchies

Каждый раз, когда добавляешь подкласс в иерархии A, обязан добавить парный в иерархии B.

**Рефакторинг**: Move Method / Move Field, чтобы убрать одну иерархию (свести её к composition).

### Dispensables — лишний код

#### 12. Comments

Длинные комментарии, объясняющие «что» код делает — знак, что код не объясняет себя сам. Хорошие комментарии объясняют «почему».

**Рефакторинг**: Extract Function с говорящим именем; Rename Variable.

#### 13. Duplicate Code

Копипаст. Самая очевидная форма — идентичные блоки. Скрытая — структурно похожий код с разными деталями.

**Рефакторинг**: Extract Function (для точной копии); Pull Up Method (для дублей в подклассах); Form Template Method (для структурной похожести); Parameterize Function (для похожих функций с магическими значениями).

Инструмент для поиска: `jscpd` (JS/TS/Python/Go), `cpd` (Java), `flake8-duplicate-imports`.

#### 14. Lazy Class / Freeloader

Класс, который мало делает. Часто — остаток после рефакторинга.

**Рефакторинг**: Inline Class; Collapse Hierarchy.

#### 15. Data Class

Класс, состоящий только из геттеров/сеттеров без поведения. В DDD — признак «анемичной модели».

**Рефакторинг**: Move Method — переместить в этот класс поведение, которое с ним работает.

#### 16. Dead Code

Неиспользуемые функции, поля, импорты, ветки условий. Создают ложное ощущение сложности.

**Рефакторинг**: Remove Dead Code. Инструменты: `knip`, `ts-prune`, `unimport`, `vulture` (Python), `deadcode` (Go).

#### 17. Speculative Generality

Абстракции, введённые «на всякий случай». Интерфейс с одной реализацией, фабрика без вариаций, параметры, которые нигде не используются.

**Рефакторинг**: Inline Class / Inline Function; Remove Parameter; Collapse Hierarchy. YAGNI в действии.

### Couplers — избыточные связи

#### 18. Feature Envy

Метод в классе A больше интересуется полями класса B, чем своего. `order.calculateTotal()` обращается к каждому полю `customer` — возможно, это метод customer'а.

**Рефакторинг**: Move Function; Extract Function + Move Function.

#### 19. Inappropriate Intimacy

Два класса знают друг о друге слишком много (включая приватные детали). Часто у них двунаправленная связь.

**Рефакторинг**: Move Method / Move Field; Replace Bidirectional Association with Unidirectional; Extract Class.

#### 20. Message Chains

`a.getB().getC().getD().doSomething()`. Клиент знает структуру навигации.

**Рефакторинг**: Hide Delegate. Но не переусердствуй — Law of Demeter как «закон» часто раздувает API.

#### 21. Middle Man

Класс, все методы которого просто делегируют другому классу.

**Рефакторинг**: Remove Middle Man; Inline Function.

## Как искать в коде

```bash
# Длинные функции (примерно, по количеству строк):
# JS/TS:
grep -rn "function\|=>" --include="*.{ts,tsx,js,jsx}" -A 100 | awk '/function|=>/{if (count>40) print file":"line": длинная функция"; count=0; file=$0}; {count++}'
# Универсально — через количество строк в теле:
find . -name "*.ts" -o -name "*.tsx" | xargs awk 'NF' | sort | uniq -c | sort -rn

# Дублирование кода:
npx jscpd --min-lines 10 --min-tokens 50 ./src

# Длинные списки параметров (TS/JS):
grep -rnE "function\s+\w+\([^)]{80,}\)" --include="*.{ts,tsx,js,jsx}"
grep -rnE "\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*,[^)]*\)" --include="*.{ts,tsx,js,jsx}"

# Boolean-параметры (flag arguments):
grep -rnE "\(.*: boolean" --include="*.{ts,tsx}"

# Магические числа:
grep -rnE "\b[0-9]{2,}\b" --include="*.{ts,tsx}" | grep -vE "(test|spec|\.d\.ts|const|enum)"

# Dead code (JS/TS):
npx knip
npx ts-prune

# Цикломатическая сложность:
npx eslint . --rule 'complexity: ["error", 10]'
```

## Пороги метрик

| Метрика | Порог внимания | Порог действия |
|---|---|---|
| Cyclomatic complexity | > 10 | > 15 |
| Cognitive complexity (SonarQube) | > 15 | > 25 |
| Длина функции (строки) | > 30 | > 50 |
| Длина файла (строки) | > 300 | > 600 |
| Число параметров | > 4 | > 6 |
| Depth of nesting | > 3 | > 4 |
| Число публичных методов класса | > 10 | > 20 |
| Duplication ratio | > 5% | > 10% |

Пороги — ориентиры, не жёсткие правила. Бизнес-критичный код оправдывает более высокую сложность, если она хорошо протестирована.
