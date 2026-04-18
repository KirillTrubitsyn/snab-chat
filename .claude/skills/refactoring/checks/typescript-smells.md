# TypeScript smells

## Что проверять

### 1. `any` proliferation

`any` полностью отключает проверку типов. Каждый `any` — это отверстие в типовой системе.

**Признаки**:

- `: any` в сигнатурах публичных функций.
- `as any` для «обхода» ошибок типизации.
- Использование `JSON.parse(...)` без последующей валидации (результат — `any`).
- Отсутствие `noImplicitAny` в `tsconfig`.

**Рефакторинг**:

- Для неизвестных входных данных — `unknown`, затем narrow через type predicates или Zod/Valibot/ArkType.
- Для библиотечных интеграций без типов — напиши свой declaration-file или найди `@types/*`.
- Включи `strict: true` и `noImplicitAny: true` в `tsconfig`.

### 2. Type assertion abuse (`as`)

`as` говорит TypeScript: «Доверься мне». Это ложь, и она часто оборачивается runtime-ошибкой.

**Признаки**:

- `value as SomeType` в бизнес-коде (допустимо в тестах и в узких местах адаптации).
- `as unknown as SomeType` — двойной cast, почти всегда smell.

**Рефакторинг**:

- Используй type guards (`is`-функции):
  ```ts
  function isUser(x: unknown): x is User {
    return typeof x === "object" && x !== null && "id" in x && "email" in x;
  }
  ```
- Для DTO — схемная валидация (Zod, Valibot). Получаемый тип выводится из схемы.
- Для union narrowing — discriminated union.

### 3. Отсутствие discriminated unions

Union без общего дискриминатора неудобен в использовании.

```ts
// Smell
type Response = { data: User } | { error: string };
// Как отличить?

// Правильно
type Response =
  | { status: "success"; data: User }
  | { status: "error"; error: string };
```

**Рефакторинг**: добавь литеральный дискриминатор. В switch-е используй exhaustive check с `never`.

### 4. Слишком широкие union-ы

`string | number | boolean | undefined` — признак, что тип не продуман.

**Признаки**:

- Union из 5+ примитивов в одной сигнатуре.
- Функция принимает `T | undefined | null | ""` «на всякий случай».

**Рефакторинг**: сузь тип до того, что реально нужно. Используй branded types для смысловых различий:

```ts
type UserId = string & { readonly brand: unique symbol };
type OrderId = string & { readonly brand: unique symbol };
// Теперь UserId и OrderId несовместимы, хотя оба string.
```

### 5. Enum vs const assertion

В 2025-2026 `enum` в TS считается устаревшим подходом для большинства случаев:

- `const enum` — проблемы с isolated modules, Babel, bundling.
- Обычный `enum` — странный runtime-объект с обратным маппингом чисел на имена.

**Рефакторинг**: `as const` + union:

```ts
// Вместо
enum Status { Active, Inactive, Pending }

// Предпочитай
const STATUS = {
  Active: "active",
  Inactive: "inactive",
  Pending: "pending",
} as const;
type Status = typeof STATUS[keyof typeof STATUS];
```

Исключения: когда интероп с чем-то, что уже использует enum (Prisma, generated code).

### 6. Использование `Function`, `object`, `{}`

Эти типы — псевдо-типизация:

- `Function` — любая функция, включая `new Date`.
- `{}` — всё, кроме `null` и `undefined` (включая примитивы).
- `object` — любой non-primitive.

**Рефакторинг**: замени на точные сигнатуры — `(arg: X) => Y`, `Record<string, unknown>`, конкретный interface.

### 7. Index signatures без `noUncheckedIndexedAccess`

```ts
const map: Record<string, number> = { a: 1 };
const v = map["b"]; // Тип number, значение undefined — бомба замедленного действия
```

**Рефакторинг**: включи `noUncheckedIndexedAccess: true`. Тогда `v` получит тип `number | undefined`, и компилятор заставит обработать случай.

### 8. Optional chaining там, где значение обязательно

```ts
// Smell
function render(user?: User) {
  return <span>{user?.name?.toUpperCase?.()}</span>;
}
```

Если `user.name` должен быть, типизируй его как обязательный. `?.` для обязательных значений — способ скрыть баги.

**Рефакторинг**: уточни тип. Если `user` может быть `undefined` — верни null/loader на уровне функции. Если `name` опционален — обработай явно.

### 9. Non-null assertion (`!`)

`value!` — «это точно не null/undefined, честно». Эквивалент `as NonNullable<T>`.

**Рефакторинг**: используй type guards или выброси исключение явно:

```ts
function assertDefined<T>(v: T | null | undefined, msg = "defined"): asserts v is T {
  if (v === null || v === undefined) throw new Error(`Expected ${msg}`);
}
```

Исключения: тесты, где заведомо известно, что значение есть.

### 10. Дублирование типов между фронтом и бэком

Типы API на бэкенде и фронтенде определены отдельно, вручную, часто расходятся.

**Рефакторинг**:

- Shared types в монорепо (`packages/types` или `packages/shared`).
- Генерация из OpenAPI схемы: `openapi-typescript`.
- Концы единого кода: tRPC, oRPC, Encore, Hono RPC — типы выводятся из одного определения.

### 11. Overly deep types / TypeScript performance issues

Сложные условные типы, deep recursion, `infer`-acrobatics → `tsc` медленный, IDE тормозит.

**Рефакторинг**:

- Измерь: `tsc --noEmit --extendedDiagnostics` показывает, какие типы тормозят компиляцию.
- Упрости сложные условные типы до конкретных (менее гибко, но быстрее).
- Разбей один огромный тип на несколько именованных.

### 12. Missing `readonly`

```ts
// Smell
interface Config {
  apiUrl: string;
  timeout: number;
}
```

Если конфиг не должен меняться в runtime — пометь всё `readonly`. Это документирует намерение и ловит случайные мутации.

**Рефакторинг**:

```ts
interface Config {
  readonly apiUrl: string;
  readonly timeout: number;
}
// Или целиком:
type Config = Readonly<{
  apiUrl: string;
  timeout: number;
}>;
// Для массивов — ReadonlyArray<T> или readonly T[].
```

### 13. `as const` избегается

```ts
// Smell
const DEFAULTS = { limit: 10, sort: "asc" };
// тип { limit: number; sort: string } — слишком широкий

// Правильно
const DEFAULTS = { limit: 10, sort: "asc" } as const;
// тип { readonly limit: 10; readonly sort: "asc" }
```

### 14. Ручные utility-types вместо встроенных

Переизобретают `Partial`, `Pick`, `Omit`, `Required`, `ReturnType`, `Parameters`, `Awaited`. Встроенные проверены, документированы и поддерживаются IDE.

**Рефакторинг**: используй встроенные. Для более редких задач — `type-fest` (от sindresorhus).

### 15. Отсутствие branded types для идентификаторов

Все ID в коде — `string`. Легко перепутать `userId` и `orderId`.

**Рефакторинг**: branded types (см. пункт 4). Или хотя бы type alias + дисциплина:

```ts
declare const BrandSym: unique symbol;
type Brand<T, B> = T & { readonly [BrandSym]: B };
type UserId = Brand<string, "UserId">;
type OrderId = Brand<string, "OrderId">;
```

### 16. `Record<string, T>` вместо `Map<string, T>`

Для динамических ключей `Record` имеет prototype-issues (`"toString"` как ключ, `__proto__`).

**Рефакторинг**: для данных с произвольными ключами — `Map`. Для известного набора ключей — `Record<KeyUnion, T>`.

### 17. `void` vs `undefined`

`void`-функция возвращает «что угодно, игнорируется». Если нужно именно «ничего не возвращает» — `undefined`.

```ts
// Smell: получили значение из onClick и потеряли
[1, 2, 3].forEach(onClickHandler); // onClickHandler: (arg: MouseEvent) => void — принимает number
```

**Рефакторинг**: осознанно выбирай `void` (callback-совместимость) или `undefined` (строго «ничего»).

## Как искать в коде

```bash
# Количество any
grep -rnE ":\s*any\b|<any>|as any" --include="*.ts" --include="*.tsx" | wc -l

# Type assertions
grep -rnE "\bas\s+[A-Z][a-zA-Z]*" --include="*.ts" --include="*.tsx" | grep -v "as const" | wc -l

# Non-null assertions
grep -rnE "!\.\s|!\[" --include="*.ts" --include="*.tsx" | wc -l

# Enum использования (посчитать; миграция на const assertion)
grep -rn "^enum\|^export enum\|^const enum\|^export const enum" --include="*.ts"

# Function, object, {} как типы
grep -rnE ":\s*(Function|object)\b|:\s*\{\s*\}" --include="*.ts" --include="*.tsx"

# tsconfig strict-настройки
cat tsconfig.json | jq '.compilerOptions | { strict, noImplicitAny, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noImplicitReturns, strictNullChecks }'

# Мёртвые экспорты (перед чисткой типов)
npx ts-prune
npx knip
```

## Рекомендуемые настройки tsconfig

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    // Для устранения enum-проблем при bundling:
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

Включение strict-настроек на большой кодовой базе делай поэтапно:

1. Включи одну настройку.
2. Создай baseline ошибок.
3. Исправляй по файлу за раз, не допуская роста счётчика.
4. Используй `// @ts-expect-error` для временных исключений (лучше, чем `// @ts-ignore`, потому что сам по себе становится ошибкой, когда проблема уйдёт).
