# Каталог атомарных рефакторингов

Список из книги Martin Fowler *Refactoring* (2nd ed.), адаптированный для JS/TS и современных фреймворков. Каждый рефакторинг — атомарный шаг, который либо делается целиком, либо откатывается. Никогда не комбинируй несколько пунктов в одном коммите.

## Основные рефакторинги

### Extract Function

Самый частый. Выдели блок в именованную функцию.

```ts
// До
function printOwing(invoice: Invoice) {
  let outstanding = 0;
  // print banner
  console.log("=====");
  console.log("Customer Owes");
  console.log("=====");
  // calculate outstanding
  for (const o of invoice.orders) outstanding += o.amount;
  // print details
  console.log(`name: ${invoice.customer}`);
  console.log(`amount: ${outstanding}`);
}

// После
function printOwing(invoice: Invoice) {
  printBanner();
  const outstanding = calculateOutstanding(invoice);
  printDetails(invoice, outstanding);
}

function printBanner() {
  console.log("=====");
  console.log("Customer Owes");
  console.log("=====");
}

function calculateOutstanding(invoice: Invoice): number {
  return invoice.orders.reduce((sum, o) => sum + o.amount, 0);
}

function printDetails(invoice: Invoice, outstanding: number) {
  console.log(`name: ${invoice.customer}`);
  console.log(`amount: ${outstanding}`);
}
```

Критерий качества: имя функции объясняет что она делает, не как. Если имя получается длинным — обычно функция делает слишком много.

### Inline Function

Обратный к Extract. Применяй, когда тело функции не менее очевидно, чем её имя, либо когда ненужная прослойка усложняет навигацию.

### Extract Variable

```ts
// До
if (order.quantity * order.itemPrice - Math.max(0, order.quantity - 500) * order.itemPrice * 0.05 > 1000) { ... }

// После
const basePrice = order.quantity * order.itemPrice;
const quantityDiscount = Math.max(0, order.quantity - 500) * order.itemPrice * 0.05;
const finalPrice = basePrice - quantityDiscount;
if (finalPrice > 1000) { ... }
```

### Inline Variable

Когда имя переменной не добавляет информации по сравнению с выражением.

### Change Function Declaration (Rename / Reorder / Add parameter / Remove parameter)

Меняет сигнатуру. Для публичного API применяй **Parallel Change**, не режь сразу.

### Encapsulate Variable

Оборачивай прямой доступ к переменной в функции (getter/setter). Даёт точку контроля: логирование, валидацию, защиту от мутаций.

### Rename Variable / Function / Field

Лучший рефакторинг по соотношению цены и эффекта. Arlo Belshee предложил семь стадий именования:

```
1. Missing                — имени нет (анонимная функция, аргумент x)
2. Nonsense               — случайная буквенная последовательность
3. Honest                 — частично описывает (processData)
4. Honest and Complete    — полно описывает, но слишком длинно
5. Does the right thing   — имя само наводит на правильное использование
6. Intent                 — выражает намерение, не детали
7. Domain abstraction     — термин из domain-словаря
```

Цель — двигаться вверх по шкале. Код на третьем уровне лучше, чем на втором, и так далее.

### Introduce Parameter Object

```ts
// До
function createReport(startDate: Date, endDate: Date, includeZero: boolean, format: "pdf" | "csv") { ... }

// После
interface ReportParams {
  period: { start: Date; end: Date };
  includeZero: boolean;
  format: "pdf" | "csv";
}
function createReport(params: ReportParams) { ... }
```

### Combine Functions into Class

Несколько функций работают с одной структурой, принимая её первым аргументом, — кандидат на класс или модуль.

### Combine Functions into Transform

Альтернатива для FP-стиля: функция-transform, которая принимает данные и возвращает обогащённую версию.

### Split Phase

Функция делает «разбор → обработка → форматирование». Раздели на три шага с явными промежуточными структурами.

### Move Function / Move Field

Перенеси в модуль, где этот код чаще используется. Снижает coupling.

### Extract Class / Inline Class

Класс делает слишком много — выдели часть. Или наоборот, класс ничего не делает — inline.

### Hide Delegate / Remove Middle Man

Балансируй: один клиент не должен знать всей глубины объектной навигации, но и паразитные прокси-классы не нужны.

### Substitute Algorithm

Замена одной реализации алгоритма на другую. Поведение сохраняется. Применяй с характеризационными тестами.

## Работа с условной логикой

### Decompose Conditional

```ts
// До
if (date.isBefore(SUMMER_START) || date.isAfter(SUMMER_END)) {
  charge = quantity * winterRate + winterServiceCharge;
} else {
  charge = quantity * summerRate;
}

// После
if (isSummer(date)) {
  charge = summerCharge(quantity);
} else {
  charge = winterCharge(quantity);
}
```

### Consolidate Conditional Expression

```ts
// До
if (a.seniority < 2) return 0;
if (a.monthsDisabled > 12) return 0;
if (a.isPartTime) return 0;
// логика

// После
if (isIneligible(a)) return 0;
// логика
```

### Replace Nested Conditional with Guard Clauses

```ts
// До
function getPay(emp: Employee): number {
  let result;
  if (emp.isSeparated) {
    result = { amount: 0, reasonCode: "SEP" };
  } else {
    if (emp.isRetired) {
      result = { amount: 0, reasonCode: "RET" };
    } else {
      result = { amount: computePay(emp) };
    }
  }
  return result;
}

// После
function getPay(emp: Employee): number {
  if (emp.isSeparated) return { amount: 0, reasonCode: "SEP" };
  if (emp.isRetired)   return { amount: 0, reasonCode: "RET" };
  return { amount: computePay(emp) };
}
```

### Replace Conditional with Polymorphism

`switch` по типу — классический случай. Замена — полиморфизм (в ООП) или discriminated union + exhaustive check (в TS):

```ts
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; width: number; height: number }
  | { kind: "triangle"; base: number; height: number };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":   return Math.PI * s.radius ** 2;
    case "rect":     return s.width * s.height;
    case "triangle": return 0.5 * s.base * s.height;
    default: {
      const _: never = s;
      throw new Error("unreachable");
    }
  }
}
```

### Introduce Special Case (Null Object)

Вместо проверок `if (user === null)` везде — специальный объект `NullUser`, у которого те же методы, но с безопасными по умолчанию значениями.

### Replace Error Code with Exception / Replace Exception with Precheck

Первый — когда код возвращает `-1` как индикатор ошибки. Второй — когда исключения используются для ожидаемых ситуаций (анти-паттерн «exceptions as control flow»).

## Работа с коллекциями

### Replace Loop with Pipeline

```ts
// До
const names: string[] = [];
for (const p of people) {
  if (p.age >= 18 && p.active) {
    names.push(p.name.toUpperCase());
  }
}

// После
const names = people
  .filter(p => p.age >= 18 && p.active)
  .map(p => p.name.toUpperCase());
```

Осторожно с производительностью: несколько проходов по массиву иногда медленнее одного цикла. Для большинства приложений это не критично.

### Split Loop

Цикл делает два несвязанных действия — раздели.

## Работа с данными

### Encapsulate Record

Замена анонимных объектов на классы/типы с контролируемым доступом.

### Replace Primitive with Object

`amount: number` → `Money { amount: number; currency: Currency }`. Value object с поведением.

### Replace Magic Literal / Replace Magic Number with Symbolic Constant

```ts
// До
if (age >= 65) { ... }

// После
const RETIREMENT_AGE = 65;
if (age >= RETIREMENT_AGE) { ... }
```

Для связанных констант — `as const` объект, не разрозненные `const`.

### Change Value to Reference / Change Reference to Value

Первый — когда одинаковые данные размножаются; выдели общий объект. Второй — когда immutable-ссылки упрощают модель.

## Организация кода модулей

### Move Method (Move Function between modules)

### Pull Up Method / Pull Up Field

Дублирование в подклассах → поднять в родителя.

### Push Down Method / Push Down Field

Родитель содержит, что нужно только одному подклассу → опустить.

### Extract Superclass / Extract Interface

Общее поведение выдели вверх.

### Replace Subclass with Delegate

Наследование всё чаще заменяют на композицию. Применяй, когда подкласс — это не «is-a», а «has capability».

### Remove Dead Code

`knip` / `ts-prune` / `unimport` — найди, затем удаляй осознанно. Иногда «мёртвый» код — это то, что вызывается через dynamic import или reflection; проверь.

## React-специфичные рефакторинги

### Extract Custom Hook

```tsx
// До
function Profile() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    fetchUser()
      .then(u => { setUser(u); setLoading(false); })
      .catch(e => { setError(e); setLoading(false); });
  }, []);
  if (loading) return <Spinner />;
  if (error) return <Error error={error} />;
  return <ProfileView user={user!} />;
}

// После
function useUser() {
  // ... вся загрузка
  return { user, loading, error };
}
function Profile() {
  const { user, loading, error } = useUser();
  if (loading) return <Spinner />;
  if (error) return <Error error={error} />;
  return <ProfileView user={user!} />;
}
```

В приложении с TanStack Query это вообще сводится к `useQuery`.

### Extract Component

JSX-блок выделяется в отдельный компонент, когда: (а) становится самостоятельной единицей, (б) имеет собственное состояние, (в) переиспользуется.

### Replace Prop Drilling with Composition

См. `react-smells.md`, пункт 1.

### Replace useEffect with Direct Computation

Derived state → вычисление при рендере, а не synchronization-эффект.

### Replace Render Props with Custom Hook

Паттерн render-props в 2025 году почти всегда элегантнее решается кастомным хуком.

### Convert Class Component to Function Component

Механический рефакторинг через codemod.

## Дисциплина применения

- Один рефакторинг — один коммит.
- Коммит-сообщение в формате `refactor(<scope>): <что>`. Например: `refactor(auth): extract useSession hook from LoginPage`.
- Между рефакторингами прогоняй тесты. Каждый коммит зелёный.
- Если рефакторинг получился большим — разбей на шаги и коммитай по каждому.
- В PR — один тип рефакторинга. Если приходится объединять, в описании PR явно перечисли.

## Полезные инструменты

- **IDE refactoring**: VS Code / WebStorm имеют встроенные рефакторинги (rename, extract function). Для TS они безопасные и учитывают все использования — пользуйся.
- **ast-grep / ts-morph / jscodeshift** — для массовых механических трансформаций.
- **prettier / biome** — форматирование после рефакторинга не должно попадать в тот же коммит. Отформатируй однократно отдельным «chore: format» коммитом.

## Ссылки

- Martin Fowler. *Refactoring: Improving the Design of Existing Code*, 2nd ed.
- Интерактивный каталог: [https://refactoring.com/catalog/](https://refactoring.com/catalog/).
- [https://refactoring.guru](https://refactoring.guru) — визуализации.
