# Тесты как smell

## Что проверять

Плохие тесты хуже отсутствия тестов: они создают ложное ощущение безопасности и активно мешают рефакторингу. Прежде чем полагаться на тестовый корпус, оцени его качество.

### 1. Тесты на реализацию вместо поведения

Тест проверяет, что функция X вызвала функцию Y с аргументом Z. Меняешь реализацию (Y → Y'), тесты падают, хотя поведение идентично.

**Признаки**:

- Много `vi.mock`, `jest.mock`, `sinon.stub` внутри одного теста.
- Assertions типа `expect(mock).toHaveBeenCalledWith(...)` — без assertion на результат.
- Тесты падают при любом рефакторинге, даже безобидном переименовании приватного метода.

**Рефакторинг**:

- Тестируй через публичный API модуля.
- Mock только границы (внешний HTTP, БД, файловая система, часы).
- Для всего внутри модуля — реальный код.

### 2. Snapshot tests на всё подряд

Snapshot-тесты, занимающие пол-экрана, обновляемые автоматически при падении без разбора — бесполезны.

**Признаки**:

- `.snap` файлы длиннее 50 строк на один тест.
- Ревью PR всегда содержит «snapshot updates».
- Разработчики на автомате обновляют снапшоты командой `-u`.

**Рефакторинг**:

- Snapshot только для мелких, стабильных сериализаций (DTO, error messages, fixed UI primitives).
- Для UI — визуальные регрессии через Chromatic / Percy / Playwright visual comparisons, не text snapshots.
- Для сложных структур — явные assertions на ключевые поля.

### 3. Mocked everything

В тесте `UserService` замокан репозиторий, email, logger, config, часы. Тестируется ровно то, что внутри `UserService.register` вызывается в правильном порядке.

**Рефакторинг**:

- Integration-тест с in-memory реализациями зависимостей.
- Используй testcontainers для реальной БД в integration-тестах.
- Переключай unit/integration в зависимости от того, что проверяется.

### 4. Отсутствие arrange/act/assert

Код теста перемешан, setup и assertion разбросаны.

**Рефакторинг**: жёсткий AAA-pattern:

```ts
test("calculates discount for VIP customer", () => {
  // Arrange
  const order = createOrder({ total: 100 });
  const customer = createCustomer({ tier: "vip" });

  // Act
  const discounted = applyDiscount(order, customer);

  // Assert
  expect(discounted.total).toBe(90);
});
```

### 5. Logic в тестах

Циклы, условия, вычисления внутри тестов → тесты сами содержат баги, которые их же и обходят.

**Признаки**:

- `if (...) expect(...).toBe(...); else expect(...).toBe(...)`.
- `for` по данным с условными assertions.
- Вычисления expected-значения формулой, которая совпадает с тестируемой функцией.

**Рефакторинг**:

- Parameterized tests (`test.each`, `it.each`, `pytest.mark.parametrize`).
- Захардкоженные expected-значения.
- Один тест — один сценарий.

### 6. Плохие имена тестов

`test("works correctly")`, `test("test 1")`, `test("user test")` — не описывают, что проверяется.

**Рефакторинг**: формат «Given / When / Then» или Arlo Belshee's pattern: `methodName_condition_expectedResult`:

- `applyDiscount_vipCustomer_tenPercentOff`
- `register_emailAlreadyExists_throwsConflictError`

### 7. Flaky tests

Тесты, которые иногда проходят, иногда нет. Часто причина: зависимость от времени, порядка, параллельности, сети.

**Рефакторинг**:

- Моки для `Date.now()`, `setTimeout`, random.
- Изоляция между тестами: не шарь state (БД, файлы, глобальные переменные).
- Явное ожидание вместо `setTimeout`: `waitFor`, `findByText`.
- Для сетевых — MSW (Mock Service Worker), а не real network.
- Flaky тест в CI — немедленно квaрантин + root cause investigation. Не игнорь.

### 8. Медленные тесты

Unit test, который идёт 2 секунды, — это не unit test. Юнит-тесты должны прогоняться тысячами за секунды.

**Признаки**:

- Каждый тест поднимает приложение.
- Тесты дёргают реальную сеть.
- Sleep / waitFor с большими таймаутами.

**Рефакторинг**:

- Разнеси на unit / integration / e2e с разной скоростью и разным запуском в CI.
- Пирамида тестов (много быстрых unit, меньше integration, совсем немного e2e).
- Используй `describe.concurrent` / parallel (Vitest, Jest).

### 9. Тесты не изолированы

Тест А что-то создаёт в БД. Тест B этим пользуется. Запустишь B в одиночку — сломается.

**Рефакторинг**:

- `beforeEach` / `afterEach` с полной очисткой.
- Транзакция на каждый тест с rollback.
- Уникальные ID/namespaces для параллельного запуска.

### 10. Тесты есть, а coverage нулевой

Тест есть, проходит, но ничего содержательного не проверяет.

```ts
test("renders component", () => {
  render(<MyComponent />);
  // Нет assertion — тест «проходит», даже если компонент падает с предупреждением
});
```

**Рефакторинг**: каждый тест заканчивается хотя бы одним `expect`. Используй mutation testing (Stryker) для проверки, что тесты действительно что-то ловят.

### 11. Coverage-driven testing

Тесты пишутся ради coverage-процента, а не для проверки поведения.

**Признаки**:

- Тесты вызывают функцию и ничего не проверяют (см. п.10).
- Покрыты тривиальные геттеры, но не сложная логика.
- `if (condition) doSomething()` — покрыт только happy path.

**Рефакторинг**:

- Фокус на **branch coverage**, не line coverage.
- Mutation testing показывает реальное качество тестов.
- Пиши тесты для сценариев, не для строк.

### 12. Тесты без характеризации

Unit-тест проверяет happy path; что происходит при edge cases — неизвестно.

**Рефакторинг**:

- Property-based testing (fast-check в JS/TS, hypothesis в Python) для инвариантов.
- Граничные случаи явно: null, undefined, пустая строка, 0, отрицательные, очень большие.
- Характеризационные тесты для legacy (см. `safety-net.md`).

### 13. Assertions с `try/catch`

```ts
// Smell
try {
  fn();
  fail("should have thrown");
} catch (e) {
  expect(e.message).toBe("...");
}
```

**Рефакторинг**:

```ts
expect(() => fn()).toThrow("...");
await expect(asyncFn()).rejects.toThrow("...");
```

### 14. E2E-тесты как единственный safety net

Все тесты — e2e через реальный браузер. Прогоняются полчаса, flaky, неудобны для TDD.

**Рефакторинг**: добавь unit и integration слои. E2E оставь для критичных user journeys (логин, оплата).

## Как искать в коде

```bash
# Подозрительно много моков в одном файле
for f in $(find . -name "*.test.*" -o -name "*.spec.*"); do
  count=$(grep -c "vi\.mock\|jest\.mock\|sinon\.stub" "$f")
  [[ $count -gt 5 ]] && echo "$f: $count моков"
done

# Тесты без assertion
for f in $(find . -name "*.test.ts" -o -name "*.test.tsx"); do
  # очень грубая эвристика
  body_lines=$(wc -l < "$f")
  expects=$(grep -c "expect(" "$f")
  [[ $body_lines -gt 20 && $expects -eq 0 ]] && echo "Подозрительно: $f"
done

# Snapshot-файлы-монстры
find . -name "*.snap" -exec wc -l {} \; | sort -rn | head -20

# Тесты с skip/xit
grep -rnE "\.skip\(|xit\(|xdescribe\(|@pytest\.mark\.skip" --include="*.test.*" --include="*.spec.*"

# Длительность тестов (Vitest / Jest с --reporter=verbose)
npx vitest --reporter=verbose 2>&1 | grep -E "[0-9]+ms" | sort -k 2 -rn

# Mutation score (если Stryker настроен)
cat reports/mutation/mutation.json | jq '.metrics.mutationScore'
```

## Эталон

Для рефакторинга нужен тестовый корпус, в котором:

- Unit-тесты проверяют публичный API модулей, mock только границы.
- Каждый модуль имеет integration-тест с реальными зависимостями (in-memory или testcontainers).
- E2E-тесты проверяют критичные user journeys.
- Все тесты запускаются менее чем за 5 минут (CI: параллельно).
- Mutation score ≥ 70% по модулю, для критичных ≥ 85%.
- Coverage как ориентир, не как цель.
