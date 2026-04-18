# Next.js App Router smells

## Что проверять

Набор smells, специфичных именно для Next.js с App Router (`app/`). Правила актуальны для Next.js 14/15. Для Pages Router (`pages/`) многие пункты неприменимы.

### 1. Избыточное использование `"use client"`

Самый распространённый smell в App Router. `"use client"` «заражает» всё дерево: ребёнок серверного компонента становится клиентским, если родитель клиентский. Избыточные client-директивы увеличивают JS-бандл и теряют преимущества RSC.

**Признаки**:

- `"use client"` в `layout.tsx` корневого уровня.
- `"use client"` в компоненте, который не использует ни одного из: `useState`, `useEffect`, `onClick`, `onChange`, `useRouter`, browser API.
- `"use client"` в компоненте только потому, что один его потомок интерактивен.

**Рефакторинг**:

- По умолчанию — серверный компонент. Клиент — только для интерактивности.
- Изолируй клиентский «остров»: оставь оборачивающий компонент серверным, перенеси только `onClick`-кнопку в отдельный `ClientButton.tsx` с `"use client"`.
- Если компонент клиентский, но его children могут быть серверными — принимай children как пропс, это сохраняет серверный рендеринг вложенных:

```tsx
// ClientWrapper.tsx
"use client";
export function ClientWrapper({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div onClick={() => setOpen(!open)}>{children}</div>;
}

// page.tsx (server)
<ClientWrapper>
  <ServerOnlyContent /> {/* остаётся серверным */}
</ClientWrapper>
```

### 2. Нарушение server/client-границы

Серверные данные утекают в клиентский контекст, или наоборот.

**Признаки**:

- Несериализуемые объекты (функции, классы, Date в старых версиях) передаются как пропсы из server в client component.
- Переменные окружения без префикса `NEXT_PUBLIC_` используются в клиентском коде — рантайм-ошибка в production.
- `headers()`, `cookies()`, `draftMode()` вызываются в клиентском компоненте.
- Прямые SQL-запросы или работа с `fs` внутри файла с `"use client"`.

**Рефакторинг**: серверную работу оставляй на сервере; клиенту передавай только сериализуемые DTO. Для секретов — строго серверные переменные окружения и Server Actions для записи.

### 3. Антипаттерны fetch-а данных в RSC

- **Водопад запросов**: серверный компонент ждёт `await fetch(A)`, затем дочерний ждёт `await fetch(B)`. Если они независимы — это потеря времени.

  **Рефакторинг**: `Promise.all([fetchA, fetchB])`, или параллельные компоненты с `Suspense`-границами.

- **Дубли одних и тех же запросов в разных местах**: каждый компонент делает свой `fetch` того же URL.

  **Рефакторинг**: Next.js 14 автоматически дедуплицирует идентичные fetch-запросы в рамках одного рендера. Убедись, что URL и опции идентичны. Для более сложных случаев — `React.cache()` вокруг data-access-функции.

- **Fetch в клиентском компоненте для начальной загрузки**: вместо RSC запрашиваем данные на клиенте после гидратации → мигающий UI, лишний JS.

  **Рефакторинг**: перенеси data fetching в серверный компонент, передавай данные как пропс. Клиентское состояние — только для interactive updates.

### 4. Неявное отключение кэширования

Next.js 15 по умолчанию **не кэширует** GET Route Handlers и fetch-запросы (в отличие от Next.js 14). Старые привычки могут приводить к неожиданным повторным запросам или, наоборот, к избыточному кэшированию.

**Проверить**:

- Какая версия Next.js? (`package.json`).
- Используются ли явно `cache: "force-cache"`, `cache: "no-store"`, `revalidate`?
- Используется ли `unstable_cache`, `"use cache"` (Next.js 15+)?

**Рефакторинг**: явно указывай стратегию кэширования для каждого data-доступа. Не полагайся на defaults, которые меняются между версиями.

### 5. Неправильное использование `layout.tsx`

- В `layout.tsx` делается fetch, который на самом деле нужен только одной странице.
- `layout.tsx` помечен как `"use client"` — тогда ВСЕ дочерние страницы теряют RSC.
- State в layout для модалок/меню, которое живёт между навигациями, — иногда это и нужно, но часто неожиданно.

**Рефакторинг**: fetch на уровне страницы, а не layout, если данные нужны только ей. Клиентскую логику layout'а выноси в отдельный клиентский подкомпонент.

### 6. Parallel Routes и Intercepting Routes без необходимости

Parallel routes (`@modal`, `@sidebar`) и intercepting routes (`(.)modal`) — мощные инструменты, но усложняют отладку. Их использование для простой модалки — overkill.

**Рефакторинг**: для диалогов внутри страницы — обычный клиентский state. Parallel/intercepting — только когда нужно, чтобы URL отражал состояние, и при deep link работала fallback-страница.

### 7. Server Actions вместо API Routes там, где нужен API

- Server Action для публичного API, которое зовётся из мобильного приложения — не работает, Server Actions внутренний механизм.
- API Route для внутренней формы внутри приложения — лишний слой; Server Action проще.

**Рефакторинг**:

- Внутренние формы → Server Actions + `useActionState`, `useFormStatus`.
- Публичное API для внешних клиентов → Route Handlers (`app/api/.../route.ts`) или tRPC / oRPC.

### 8. Использование `generateStaticParams` + dynamic данные

Если страница строится статически (`generateStaticParams`), а внутри использует `cookies()` / `headers()` / `searchParams` — конфликт: либо Next.js выдаст ошибку, либо страница станет динамической.

**Рефакторинг**: явно определи, статическая страница или динамическая. Для частично динамических данных — Partial Prerendering (Next.js 15+, экспериментально).

### 9. Metadata разбросана по компонентам

`generateMetadata` используется непоследовательно: часть страниц имеет метаданные, часть нет, часть дублирует логику.

**Рефакторинг**: единый helper для построения Metadata из доменной модели; `generateMetadata` в каждой странице вызывает его.

### 10. Ошибки и loading не на месте

`loading.tsx` и `error.tsx` — route-level Suspense boundaries. Если их нет, весь сегмент ждёт самый медленный запрос; любая ошибка ломает страницу.

**Рефакторинг**:

- Добавь `loading.tsx` для каждого сегмента с медленной загрузкой.
- Добавь `error.tsx` для критичных сегментов (и `global-error.tsx` для корня).
- Для более гранулярных границ — `<Suspense>` и `<ErrorBoundary>` внутри разметки.

### 11. Middleware делает слишком много

Middleware запускается на каждый запрос и имеет строгие ограничения (Edge runtime, 1MB бандл). Тяжёлая логика там — smell.

**Признаки**:

- Импорт тяжёлых библиотек в middleware (ORM, криптография, image processing).
- Middleware делает несколько fetch-ов для авторизации.

**Рефакторинг**: минимизируй middleware до редиректов и проверок токенов. Тяжёлую логику вынеси в Route Handlers или Server Components.

### 12. Клиентские env-переменные в большом количестве

`NEXT_PUBLIC_*` зашиваются в клиентский бандл. Если их много — часть из них, вероятно, не должна быть публичной.

**Рефакторинг**: каждую `NEXT_PUBLIC_*` переменную проверь: действительно ли клиент должен её видеть? Секреты (API-ключи с полным доступом, DB credentials) — строго без префикса.

### 13. Неправильная обработка Server Action errors

Server Action бросает исключение → клиент получает generic «something went wrong» без деталей.

**Рефакторинг**: возвращай из Server Action discriminated result (`{ success: true, data }` | `{ success: false, error }`). Используй `useActionState` для отображения.

### 14. Route Groups без цели

`(group)` — организационный приём, не должен влиять на URL. Если в проекте десятки route groups без чёткой логики группировки — это лишний шум.

**Рефакторинг**: используй route groups только для: (а) общего layout для части страниц, (б) разделения на логические секции (marketing vs app). Иначе — flat structure.

## Как искать в коде

```bash
# Излишние "use client" (клиентские без интерактивности)
grep -rln '"use client"' app/ components/ | while read f; do
  if ! grep -qE "useState|useEffect|onClick|onChange|onSubmit|useRouter|useFormState|useActionState" "$f"; then
    echo "Подозрительно клиентский: $f"
  fi
done

# "use client" в layout
grep -rln '"use client"' app/**/layout.tsx

# fetch с неявной политикой кэширования
grep -rn "fetch(" --include="*.{ts,tsx}" app/ | grep -v "cache:\|revalidate:\|next:"

# Server-only API в клиентских компонентах
for f in $(grep -rln '"use client"' app/ components/); do
  grep -n "cookies()\|headers()\|draftMode()\|process\.env\.[A-Z_]*[^_]" "$f"
done

# Несериализуемое в пропсах (эвристика)
grep -rnE "<[A-Z][a-zA-Z]*\s+[a-zA-Z]+=\{.*function|<[A-Z][a-zA-Z]*\s+[a-zA-Z]+=\{.*new Date" --include="*.{tsx}"

# Отсутствие error.tsx и loading.tsx по сегментам
find app -type d -mindepth 1 | while read d; do
  [[ ! -f "$d/error.tsx" && -f "$d/page.tsx" ]] && echo "Нет error.tsx: $d"
  [[ ! -f "$d/loading.tsx" && -f "$d/page.tsx" ]] && echo "Нет loading.tsx: $d"
done

# Избыточное количество NEXT_PUBLIC_
grep -rn "NEXT_PUBLIC_" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.env*" | wc -l
```

## Полезные ссылки

- React team: [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
- Next.js docs: [Composition Patterns](https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns)
- Next.js docs: [Caching behavior](https://nextjs.org/docs/app/deep-dive/caching)
- Next.js docs: [Partial Prerendering](https://nextjs.org/docs/app/api-reference/config/next-config-js/ppr)
