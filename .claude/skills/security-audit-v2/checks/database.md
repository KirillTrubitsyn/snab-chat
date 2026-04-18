# База данных

## Что проверять

### 1. Row Level Security (Supabase / PostgreSQL)

- Включён ли RLS на всех таблицах? Таблица без RLS доступна любому с `anon` key.
- Для каждой таблицы с RLS: какие политики применяются? Достаточно ли они restrictive?
- Есть ли политика `USING (true)` (разрешает всё)? Это анти-паттерн.
- Проверь, что SELECT/INSERT/UPDATE/DELETE покрыты отдельными политиками, а не одной permissive.
- Проверь, что политики используют `auth.uid()` или эквивалент, а не trust-данные из request body.
- При использовании JWT-claims в RLS — проверь, что claims действительно под контролем сервера, а не могут быть подделаны.

```sql
-- Таблицы без RLS:
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' AND NOT rowsecurity;

-- Политики:
SELECT schemaname, tablename, policyname, cmd, qual, with_check 
FROM pg_policies 
ORDER BY tablename, policyname;

-- Политики с USING (true) — анти-паттерн
SELECT * FROM pg_policies WHERE qual = 'true';
```

### 2. Ключи доступа к БД

- Какой ключ используется на клиенте: `anon` (правильно) или `service_role` (критическая уязвимость)?
- `service_role` key обходит RLS. Убедись, что он используется только в серверном коде (API routes, server actions, backend edge functions).
- Проверь: не передаётся ли `service_role` через публичные env-переменные (`NEXT_PUBLIC_*`)?
- Для собственных Postgres: роли per-service, не общий `postgres` superuser в приложении.

### 3. SQL Injection

- Используется ли ORM / query builder (Prisma, Drizzle, Sequelize, SQLAlchemy, ActiveRecord, Kysely) или raw SQL?
- Если raw SQL: параметризованы ли запросы? Ищи конкатенацию строк в SQL:
  ```
  `SELECT * FROM users WHERE id = '${userId}'`  // уязвимо
  `SELECT * FROM users WHERE id = $1`, [userId]  // безопасно
  ```
- Tagged template literals в Drizzle / Prisma: `sql\`SELECT ... ${userId}\`` — уязвимо если не через `sql.param()`.
- Проверь RPC-функции (Supabase): есть ли функции типа `exec_sql`, которые принимают произвольный SQL от клиента?
- `SELECT ... FROM ${dynamicTable}` — имена таблиц/колонок часто подставляются конкатенацией, стандартная параметризация не работает, нужен whitelist.

### 4. NoSQL Injection

Для MongoDB, DynamoDB, Firestore и других NoSQL — грамотные grep-паттерны не находят injection, нужен ручной анализ.

- **MongoDB operator injection**: если body передаётся в запрос напрямую, атакующий может подать `{"email": {"$ne": null}, "password": {"$ne": null}}` и обойти auth. Защита: явное приведение типов перед использованием.
- `$where: "JavaScript code"` — позволяет выполнить JS на сервере MongoDB, запрещено в production.
- `$regex` без ограничений — ReDoS-риск.
- Mongoose strict mode: проверь, что схема в strict mode и не принимает произвольные поля.
- Firestore security rules: проверь правила — часто фейково-restrictive, но разрешают доступ при определённых условиях.

### 5. Vector databases (LLM08:2025 cross-reference)

См. детали в `llm-security.md`, раздел LLM08. Здесь — БД-специфичная проверка:

- **pgvector**: таблицы с embeddings имеют RLS? Тест: аутентифицироваться как tenant B, запросить chunks с `user_id = A` — должен вернуть пусто, даже если cosine distance высокое.
- **Pinecone**: API keys per-tenant или хотя бы per-environment? Namespace берётся из trusted context, не из body.
- **Weaviate / Qdrant**: collection-level ACLs. Service account имеет минимальные права (read для query-flow, write отдельно).
- **Cross-collection queries** должны быть заблокированы на уровне API или вызывать принудительный tenant filter.
- Metadata в retrieved chunks — не содержит ли PII из других tenant'ов?

### 6. Redis / key-value stores

- Redis для сессий: TLS (`rediss://`, не `redis://`)? Auth включён?
- Redis экспонирован на public network? Это RCE через `CONFIG SET dir` + `SET` для записи SSH keys.
- Rate limiter state в Redis: eviction policy (нельзя LRU без backing).
- Memcached: похожие проверки.

### 7. Целостность данных

- **Каскадные удаления**: при удалении родительской записи удаляются ли дочерние, или остаются orphaned records? Проверь `ON DELETE CASCADE` в миграциях / schema.
- **Soft delete**: для критичных данных (пользователи, транзакции) используется ли soft delete (`deleted_at` timestamp) вместо физического удаления?
- **Race conditions**: при создании пользователей, регистрации устройств, бронировании слотов — есть ли unique constraints и/или оптимистичная блокировка?
- **Bulk DELETE scope**: может ли `DELETE ?all=true` удалить данные всех пользователей, или scope ограничен `WHERE user_id = current_user`?
- **Idempotency keys**: для платёжных и критичных операций — есть ли?

### 8. Связанные файлы в storage

- При удалении записи из БД (например, документа) удаляются ли связанные файлы из object storage?
- Остаются ли orphaned файлы после удаления метаданных?

### 9. Миграции

- Есть ли миграции, которые дропают таблицы или колонки без бэкапа?
- Есть ли в миграциях хардкоженные данные (seed data с реальными паролями)?
- Reversible: миграции имеют rollback? Или down-миграции отсутствуют?
- Миграции применяются в CI/CD automatically, или только вручную через review?

### 10. Secrets в connection strings

- `DATABASE_URL` с встроенным паролем — в env-переменной, а не в коде?
- Connection pooling credentials (Supavisor, PgBouncer) — с разными правами на pool и user?
- SSL connections: `sslmode=require` или `sslmode=verify-full`, не `disable`.

## Как искать в коде

```bash
# Supabase client initialization
grep -rn "createClient\|supabase\.\|SUPABASE_\|service_role\|anon" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.env"

# Raw SQL
grep -rn "\.query(\|\.execute(\|\.raw(\|sql\`" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"
grep -rEn "SELECT.*FROM|INSERT.*INTO|UPDATE.*SET|DELETE.*FROM" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# String concatenation in SQL
grep -rEn "\\\$\\{.*\\}.*(WHERE|SELECT|INSERT|UPDATE|DELETE)|f\".*SELECT|f'.*SELECT" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# NoSQL injection operators в user-facing коде
grep -rEn '\\$ne|\\$gt|\\$lt|\\$where|\\$regex|\\$or|\\$in' --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py"

# RPC functions
grep -rn "\.rpc(\|create_function\|EXECUTE\|exec_sql" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.sql" --include="*.py"

# Cascade/delete
grep -rn "ON DELETE\|onDelete\|cascade\|\.delete(\|\.destroy(" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.sql" --include="*.prisma"

# RLS-политики
grep -rn "CREATE POLICY\|ALTER POLICY\|USING (\|WITH CHECK (\|auth\.uid\|auth\.jwt" --include="*.sql"

# Vector DB clients
grep -rn "pinecone\|weaviate\|qdrant\|pgvector\|chromadb\|milvus\|cohere.embed" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.json" --include="requirements.txt"

# Redis / Memcached
grep -rn "redis\|ioredis\|Memcached\|memcache" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.json" --include="requirements.txt"

# Mongoose strict
grep -rn "strict:\|Schema(" --include="*.ts" --include="*.js"

# SSL mode в connection
grep -rn "sslmode=\|ssl:\s*false\|ssl:\s*{" --include="*.ts" --include="*.js" --include="*.py" --include="*.env"
```
