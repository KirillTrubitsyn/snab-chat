# State-management smells

## Что проверять

Состояние бывает нескольких видов, и путаница между ними — частая причина архитектурных проблем. Прежде чем выбирать инструмент, классифицируй состояние.

### Классификация состояния

1. **Server state** — данные, которые живут на сервере, а клиент имеет кэш. Инвалидация, кэширование, retry, dedup — ключевые проблемы.
2. **UI state (local)** — открыта ли модалка, что введено в поле, какой таб активен. Локально компоненту.
3. **Application state (shared client)** — тема, локаль, текущий пользователь (не «данные о нём», а факт авторизации). Общее, но клиентское.
4. **URL state** — фильтры, пагинация, выбранная сущность. Должны быть в URL для shareability и back/forward.
5. **Form state** — отдельный тип, со своими библиотеками.

### Smells

### 1. Server state в client state

Самый распространённый антипаттерн: `useState` + `useEffect(fetch)` для серверных данных.

**Признаки**:

- Ручная реализация loading / error / retry / refetch.
- Одни и те же данные загружаются в нескольких компонентах.
- Устаревшие данные в UI после mutation (нет инвалидации).
- Навигация туда-сюда перезапускает запросы, хотя данные не менялись.

**Рефакторинг**:

- TanStack Query (React Query) — для SPA и Pages Router.
- SWR — более простая альтернатива.
- Next.js App Router: fetch в Server Components + `React.cache()` + `revalidatePath` / `revalidateTag`.

### 2. Всё в Redux / Zustand / Context

Любое состояние складывается в глобальный стор, даже локальный input.

**Признаки**:

- Input-значения во всём приложении хранятся в глобальном store.
- `connect`-обёртки на компонентах, которые могли бы быть stateless.
- `useSelector` для вещей, которые не пересекают иерархию.

**Рефакторинг**:

- Локальный state — `useState` / `useReducer`.
- Server state — React Query / SWR / RSC.
- Application state — Zustand / Jotai / Context (для действительно общего).
- URL state — `useSearchParams` / `useQueryState`, `nuqs`.
- Form state — React Hook Form / TanStack Form.

### 3. Over-slicing Zustand

Десятки мелких сторов без логической группировки, перекрёстные зависимости между ними, циклы.

**Рефакторинг**:

- Сгруппируй по домену: один store на bounded context.
- Для сложной логики — slices внутри одного store с явными границами.
- Селекторы для доступа вместо прямого `store.state.x`.

### 4. Context misuse

- Один мегаконтекст со всем state приложения (theme + auth + cart + preferences) → любое изменение ре-рендерит всех потребителей.
- Value не мемоизирован, создаётся заново при каждом рендере провайдера.

**Рефакторинг**:

- Разбей на специализированные контексты.
- Отдели «данные» от «actions» (actions стабильны через `useRef`/`useCallback`).
- Для частых обновлений — Zustand / Jotai (они не ре-рендерят потребителей, не подписанных на конкретный slice).
- Мемоизируй value.

### 5. Использование URL для того, что не должно быть в URL

Временный state (открыта ли модалка «Подтвердить выход?») не должен быть в URL.

**Рефакторинг**: локальный state. URL — только для того, что имеет смысл расшарить ссылкой или сохранить в bookmarks.

### 6. Несинхронизированный URL state

Фильтры применены, но URL не обновляется. Пользователь шарит ссылку — у получателя пустая страница.

**Рефакторинг**:

- Next.js: `useSearchParams` + `router.replace`; или `nuqs` для типизированных query params.
- SPA: React Router `useSearchParams`; или TanStack Router с типизированными search params.

### 7. Redux без Redux Toolkit

Старый Redux с ручными action-types, `ADD_TODO_REQUEST` / `SUCCESS` / `FAILURE`, кучей boilerplate.

**Рефакторинг**:

- Redux Toolkit (`createSlice`, `createAsyncThunk`, RTK Query).
- Для server state — RTK Query или TanStack Query (проще).
- Если Redux не критичен — Zustand даёт 90% функциональности с 10% кода.

### 8. `useState` для сложного связанного state

Пять `useState`, где изменение одного должно атомарно менять другие.

**Рефакторинг**:

- `useReducer` для связанного state с явными actions.
- State machine (XState, Zag) для flows с несколькими состояниями (loading / error / retry / success).

### 9. Оптимистические обновления, забывшие про rollback

UI обновляется сразу, а сервер не отвечает / отвечает ошибкой — остаётся несогласованное состояние.

**Рефакторинг**:

- TanStack Query: `onMutate` + `onError` с rollback + `onSettled` с invalidation.
- React 19: `useOptimistic`.
- Для критичных операций (платежи) — показывай pending-статус, не optimistic update.

### 10. Мутации state вместо immutable updates

```ts
// Smell (в Redux до RTK, в Zustand без immer, в raw React)
setUsers((users) => {
  users.push(newUser); // мутирует, React не увидит изменения
  return users;
});
```

**Рефакторинг**: immutable update (`[...users, newUser]`) или immer / RTK / Zustand middleware.

### 11. State derived from props в state

См. также `react-smells.md`. Особенно часто встречается в state-management:

```ts
// Smell
const [filtered, setFiltered] = useState(items);
useEffect(() => {
  setFiltered(items.filter(...));
}, [items]);

// Правильно
const filtered = useMemo(() => items.filter(...), [items]);
```

### 12. Побочные эффекты в селекторах

Селекторы должны быть чистыми функциями. Если внутри селектора происходит fetch / mutation / logging — это ошибка.

**Рефакторинг**: селекторы — только projection из state. Побочные эффекты — в action handlers, middleware (Redux), или в обработчиках событий.

### 13. Глобальные singleton-классы для state

`class CartManager { static instance: CartManager }` — не сочетается с React (не триггерит рендеры), не сериализуется для SSR, усложняет тестирование.

**Рефакторинг**: заменяй на Zustand / Jotai / Context.

## Как искать в коде

```bash
# Локальный fetch в useEffect (server state в client state)
grep -rn "useEffect" --include="*.{tsx,jsx}" -A 10 | grep -B 3 "fetch(\|axios\|api\."

# Количество useState в одном файле (форма-smell)
grep -rn "useState" --include="*.{tsx,jsx}" | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head

# Context без useMemo на value
grep -rn "Provider value=" --include="*.{tsx,jsx}" | grep -v "useMemo\|useRef"

# Redux без Toolkit
grep -rn "createStore\|combineReducers" --include="*.{ts,tsx,js,jsx}"
grep -rn "@reduxjs/toolkit" package.json

# Мутации массивов в setState
grep -rnE "\.(push|pop|shift|unshift|splice|sort|reverse)\(" --include="*.{ts,tsx}" | grep -B 2 "set[A-Z]"

# Глобальные singleton-классы
grep -rn "static instance" --include="*.{ts,tsx}"
```

## Таблица выбора инструмента

| Тип состояния | Инструмент |
|---|---|
| Server state (SPA) | TanStack Query, SWR |
| Server state (Next.js App Router) | RSC + fetch + cache() + revalidate |
| UI state (local) | useState, useReducer |
| Form state | React Hook Form, TanStack Form |
| URL state (Next.js) | useSearchParams, nuqs |
| URL state (SPA) | React Router, TanStack Router |
| Application state (shared) | Zustand, Jotai, Context |
| State machines | XState, Zag |
| Mutations с оптимизмом | TanStack Query, useOptimistic (React 19) |
