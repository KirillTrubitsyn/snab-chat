# Архитектура RAG-системы Базы знаний СнабЧат

## 1. Общая схема

```
                          Запрос пользователя
                                 │
                    ┌────────────▼────────────┐
                    │   POST /api/chat        │
                    │   (Next.js API route)   │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
     Intent Classifier    Off-Topic Classifier    Memory Loader
     (Gemini Flash Lite)  (Gemini Flash)     (Supabase + summarizer)
              │                                      │
              ▼                                      ▼
     ┌────────────────┐                    Conversation context
     │ Query Analyzer │                    (recent msgs + summary)
     │ (regex/NLP)    │
     └───────┬────────┘
             │
    ┌────────▼────────┐
    │   Маршрутизатор │──── isComplexQuery() ───► score-based routing
    │   (Router)      │
    └───┬─────────┬───┘
        │         │
        ▼         ▼
 Deterministic  Agentic RAG
     RAG        (Gemini 2.5 Flash
                 + tool calling)
        │         │
        ▼         ▼
    ┌─────────────────┐
    │   Reranker       │── Gemini LLM rerank (по умолчанию)
    │                  │── Voyage AI rerank-2.5 (опционально)
    └────────┬────────┘
             │
    ┌────────▼────────┐
    │ Post-processing  │── Relationship expansion
    │                  │── Chunk images loading
    │                  │── Intent-aware rerank
    └────────┬────────┘
             │
    ┌────────▼────────┐
    │  System Prompt   │── Policy + RAG context (XML)
    │  Assembly        │── Uploaded docs context
    └────────┬────────┘
             │
    ┌────────▼────────┐
    │  LLM Generation  │── Gemini 3 Flash Preview
    │  (streaming)     │── systemInstruction + messages
    └──────────────────┘
```

## 2. Хранилище данных

### 2.1 Supabase PostgreSQL + pgvector

**Основная БД** для всех данных: документы, чанки, эмбеддинги, пользователи, диалоги.

| Таблица | Назначение |
|---------|-----------|
| `sources` | Метаданные загруженных документов (filename, mime_type, tags, storage_path, relationships JSONB) |
| `chunks` | Фрагменты документов с эмбеддингами (content, embedding vector(1536), tags[], image_paths[], fts tsvector) |
| `kg_entities` | Узлы графа знаний (name, entity_type, embedding vector(1536), source_chunk_ids[]) |
| `kg_relations` | Ребра графа знаний (source_entity_id, target_entity_id, relation_type, confidence) |
| `kg_extraction_log` | Прогресс извлечения сущностей из чанков |
| `conversations` | Диалоги с summary (для долгосрочной памяти) |
| `messages` | Сообщения с metadata JSONB |

### 2.2 Supabase Storage

- **Bucket `documents`** -- оригинальные файлы (DOCX, PDF, XLSX, PPTX, images, audio)
- **Bucket `chunk-images`** -- изображения, извлеченные из документов при чанкинге

### 2.3 Redis (ioredis)

- Rate limiting
- Кеширование сессий

## 3. Ingestion Pipeline (Загрузка документов)

### 3.1 Парсинг документов (`parser.ts`)

Поддерживаемые форматы и методы извлечения:

| Формат | Метод |
|--------|-------|
| DOCX | mammoth (HTML -> Markdown) + извлечение изображений из ZIP |
| DOC (legacy) | mammoth с fallback на Gemini OCR |
| PDF | pdf-parse с fallback на Gemini OCR (для сканов) |
| XLSX/XLS | ExcelJS -> Markdown-таблицы |
| PPTX | JSZip -> извлечение текста из XML + изображения из media/ |
| Изображения (JPG, PNG, etc.) | Gemini Vision OCR |
| Аудио (MP3, WAV) | Gemini транскрипция |
| HTML | Regex HTML-to-Markdown |
| Plain text | Прямое чтение |

Специальные возможности:
- **Multimodal ingestion**: изображения из DOCX/PPTX извлекаются и привязываются к чанкам маркерами `[СКРИНШОТ N]`
- **Gemini OCR fallback**: для отсканированных PDF и бинарных .doc файлов
- **Heuristic headings**: автодетекция заголовков в PDF-текстах (CAPS, "Глава N", etc.)

### 3.2 Чанкинг (`chunking.ts`)

**Стратегия**: семантический чанкинг по блокам markdown

- **Целевой размер чанка**: ~9000 символов (~3000 токенов)
- **Минимум**: 500 символов
- **Максимум**: 15000 символов (hard limit для больших таблиц)
- **Overlap**: последний блок предыдущего чанка переносится в следующий (если < 2000 символов и не таблица)

Типы блоков:
- **Таблицы** -- сохраняются целиком (с переносом заголовка при разбивке длинных таблиц)
- **Code blocks** -- сохраняются целиком
- **Обычный текст** -- разделяется по пустым строкам
- **Изображения** -- привязываются к чанкам по маркерам (максимум 6 на чанк -- лимит Gemini Embedding 2)

### 3.3 Эмбеддинги (`embeddings.ts`)

- **Модель**: `gemini-embedding-2-preview` (Google)
- **Размерность**: 1536
- **Multimodal**: текст + до 6 изображений в одном эмбеддинге
- **Task types**: `RETRIEVAL_DOCUMENT` для документов, `RETRIEVAL_QUERY` для запросов
- **Батчинг**: до 5 параллельных эмбеддингов

### 3.4 Тегирование

Каждый чанк получает теги для фильтрации:
- Режим закупки: `223-фз`, `вне 223-фз`
- Тип документа: `законодательство`, `положения`, `стандарт`, `методика`, `инструкции`, `договоры`, `ценообразование`, `матрица полномочий`, `реестр`, `справочники`, `форма`, `обучение`
- Специальные: `карточка контрагента`, `денормализовано`, `смр`, `пир`

### 3.5 Knowledge Graph Extraction

Таблицы `kg_entities` и `kg_relations` заполняются через API `POST /api/admin/extract-entities`.

**Параметры запроса:**
- `filterTags?: string[]` — whitelist тегов чанков. Если не указан, используется preset
  `['стандарт', 'положения', 'договоры', 'матрица полномочий']`. `[]` — обработать всё.
- `batchSize?: number` — чанков за один вызов LLM (до 10, по умолчанию 5).
- `limit?: number` — макс. чанков за один запуск (до 200, по умолчанию 50).
- `embedEntities?: boolean` — генерировать эмбеддинги для новых сущностей (default true).
- `crossDocResolution?: boolean` — семантический merge сущностей одного типа
  через embedding-сходство (default true; требует `embedEntities=true`).
- `resolveSimilarityThreshold?: number` — порог cosine similarity для merge
  (default 0.92; диапазон 0.8–0.99).

**Типы сущностей** (закупочная онтология):
`standard`, `branch`, `mtr_type`, `procedure`, `system`, `organization`, `document`,
`role`, `threshold`, `concept`, `regulation`, `section`,
`contract_party`, `obligation`, `approval_level`.

**Типы связей**:
`defines`, `references`, `requires`, `governs`, `part_of`, `belongs_to`, `supersedes`,
`amends`, `sets_threshold`, `restricts`, `delegates_to`, `requires_approval`,
`party_of`, `obliged_to`, `penalized_by`, `approves`, `escalates_to`.

Сущности имеют собственные эмбеддинги (vector(1536)) с HNSW-индексом для семантического поиска по графу.

**Cross-document entity resolution.** При upsert'е новой сущности extractor
сначала проверяет точное совпадение `canonical_name + entity_type`, затем
(для не-STRICT типов) ищет существующую сущность того же типа через
`kg_search_entities` (HNSW по эмбеддингу). Если cosine similarity ≥
`resolveSimilarityThreshold` И canonical-имена структурно совместимы
(общие токены ≥3 символов или substring-inclusion), сущности мёржатся:
к существующей добавляются `source_chunk_ids` и `source_ids` новой.
STRICT-типы (`standard`, `regulation`, `threshold`, `section`) никогда не
мёржатся по эмбеддингу, так как их идентификаторы содержат номера, которые
нельзя путать (например, «ГОСТ 12.1.005» ≠ «ГОСТ 12.1.007»).

**Мульти-онтология (per-tag промпты).** Реестр доменных онтологий в
`app/lib/kg-ontologies.ts`: для каждого поддерживаемого домена (`standards`,
`provisions`, `contracts`, `authority_matrix`, `legislation`, `registries`)
определены:
- приоритет (чем выше, тем раньше выбирается при пересечении тегов);
- список тегов-триггеров;
- allowlist приоритетных `entity_type` / `relation_type`;
- доменный `promptAddendum`, приклеиваемый к общему промпту (акценты, специфика).

Перед запуском LLM чанки группируются по домену через
`resolveOntologyForTags`; если внутри батча встречаются смешанные теги —
подключается голосование `resolveOntologyForBatch` (сумма приоритетов).
В ответе API возвращается поле `ontologyUsage: Record<domain, chunkCount>`,
показывающее, сколько чанков обработано под какой онтологией.

Ключевое преимущество — договоры и матрицы полномочий получают узко-
специализированный промпт («извлекай obligation, penalized_by, approval_level,
escalates_to») без потери обратной совместимости: общий список
`ENTITY_TYPES` / `RELATION_TYPES` остаётся union'ом всех онтологий, и чанки
без совпадения по тегам попадают в группу `default` с базовым промптом.

### 3.6 Связи между документами (`relationships.ts`)

Метаданные связей хранятся в `sources.relationships` (JSONB):
```json
{
  "parent_id": 42,
  "parent_hint": "Приказ от 16.10.2025 № 355-од",
  "children_ids": [43, 44, 45],
  "related_ids": [50],
  "type": "приложение"
}
```

Связи извлекаются из:
- Markdown-заголовков: `[Документ: Приложение 1 к ...]`
- Имен файлов: `Прил_1_(к_Приказу_...)_...`
- Метаданных: `Денормализовано: ...`, `Родительский документ: ...`

## 4. Retrieval Pipeline (Поиск)

### 4.1 Классификация запроса

#### Intent Classifier (`intent-classifier.ts`)

LLM-классификатор (Gemini 3.1 Flash Lite) определяет:
- **intent**: `spu_search` | `procedure` | `regulation` | `pricing` | `authority` | `system` | `contract` | `general`
- **fz_type**: `223` | `non-223` | `both` | `unknown`
- **search_tags**: теги для фильтрации поиска (2-5 штук)
- **query_variants**: альтернативные формулировки для multi-query search
- **confidence**: 0.0-1.0

Fallback на keyword-классификацию для коротких запросов или при ошибке LLM.

Post-LLM correction: принудительное переопределение в `spu_search` при обнаружении упоминаний юрлиц (ООО, АО, ИП и т.д.).

#### Query Analyzer (`query-analyzer.ts`)

Regex-анализатор (zero latency) извлекает:
- **Section references**: `пункт 61`, `раздел 5`, `статья 12` -> прямой lookup по тексту чанков
- **Document references**: `«Положение о закупках»`, `Стандарт СГК` -> lookup по имени файла
- **Catalog queries**: `список всех положений по 223-ФЗ` -> перечисление документов
- **Search hints**: теги для фильтрации (`ценообразование`, `смр`, `srm` и т.д.)

#### Document Intent Classifier (`document-intent.ts`)

Keyword-классификатор для работы с загруженными документами:
- `check` -- проверка на соответствие регламентам
- `summarize` -- суммаризация
- `improve` -- улучшение текста
- `write` -- составление нового документа по образцу
- `analyze` -- общий анализ
- `question` -- вопрос по содержанию

### 4.2 Маршрутизация: Deterministic vs Agentic RAG

**Решение**: `isComplexQuery()` (score-based, не бинарное)

Сигналы сложности (с весами):
| Сигнал | Вес |
|--------|-----|
| Оба режима (fz_type = "both") | +3 |
| Сравнительные слова ("сравни", "отличия") | +2 |
| Множественные ссылки на разделы | +2 |
| 3+ вопросительных слова | +1 |
| 4+ клауз, длина > 150 символов | +1 |
| Низкая confidence intent-классификатора | -1 |

**Порог**: score >= 3 -> Agentic RAG, иначе Deterministic RAG.

### 4.3 Deterministic RAG Pipeline

```
Query
  │
  ├── hybridSearch()     ── vector + FTS (Russian + Simple stemming)
  │                          RPC hybrid_search() в PostgreSQL
  │                          Вес: 70% vector, 30% FTS
  │
  ├── intentAwareSearch() ── multi-query с вариантами + tag filtering
  │                          Fallback на unfiltered при < 3 результатов
  │
  ├── fetchChunksBySection() ── прямой текстовый поиск по номерам пунктов
  │                              Обходит embedding search (слабый для "пункт 61")
  │
  ├── fetchChunksByDocument() ── прямой поиск по имени файла
  │                               keyword scoring внутри документа
  │
  ├── fetchCatalogResults()  ── 1 чанк с каждого документа по типу
  │
  ├── searchContractorCards() ── специализированный поиск карточек контрагентов
  │                               FTS + ILIKE + stem approximation + filename search
  │
  └── graphAwareSearch()     ── Knowledge Graph + hybrid search
                                KG entities -> traverse -> scoped chunks
                                Graph bonus: +0.15 к similarity
```

#### Hybrid Search (PostgreSQL RPC)

```sql
hybrid_search(query_text, query_embedding, match_count, vector_weight, fts_weight, filter_tags)
```

Три CTE:
1. **vector_results** -- cosine similarity по pgvector (IVFFlat index, lists=100)
2. **fts_russian** -- полнотекстовый поиск с русским стеммером
3. **fts_simple** -- полнотекстовый поиск без стемминга (для аббревиатур: НМЦД, ЗКО, ЕИ)

Результат: `combined_score = vector_score * 0.7 + fts_score * 0.3`

Фильтрация по тегам: `c.tags && filter_tags` (GIN-индекс).

#### Multi-Query Search

Генерация вариантов запроса по keyword-паттернам:
- Суммы + закупки -> добавляет "матрица полномочий уполномоченный руководитель лимит..."
- "Кто согласовывает..." -> "матрица полномочий закупочный коллегиальный орган..."
- Лимиты + закупки -> "лимит млн руб МТР централизованные..."
- Комиссия/ЗКО -> "закупочная комиссия коллегиальный орган ЗКО ЦЗК..."

Дедупликация по chunk ID, сохранение максимального score.

### 4.4 Agentic RAG Pipeline (`agentic-rag.ts`)

**Модель**: Gemini 2.5 Flash с tool calling.

**Инструменты** (FunctionDeclarations):

| Tool | Назначение |
|------|-----------|
| `search_knowledge_base` | Семантический поиск с фильтрацией по тегам |
| `lookup_section` | Прямой поиск по номеру пункта/раздела |
| `lookup_document` | Поиск по имени документа с keyword scoring |

**Цикл**:
1. LLM получает агентный промпт с описанием задачи
2. LLM вызывает инструменты (до 8 вызовов, до 6 шагов)
3. Результаты инструментов возвращаются LLM
4. LLM решает, нужны ли дополнительные поиски
5. Когда LLM завершает (нет function calls) -- чанки финализируются

**Entity-balanced selection**: для сравнительных запросов гарантирует минимальное представительство каждой сущности (min 2 чанка на сущность).

### 4.5 Reranking (`reranker.ts`, `voyage-reranker.ts`)

**Два режима** (env `RERANKER_MODEL`):

#### Gemini LLM Reranker (по умолчанию)

- **Модель**: `gemini-3.1-flash-lite-preview`
- LLM оценивает каждый чанк по шкале 0-10 (cross-encoder подход)
- **Blending**: `0.35 * original_score + 0.65 * llm_score`
- **Hard suppress**: при LLM score < 2.5 и token overlap < 8% -> score * 0.25
- **Strong keep bonus**: при LLM score >= 7.5 -> score * 1.05
- До 20 чанков за раз, до 1500 символов превью на чанк

#### Voyage AI Reranker (опциональный)

- **Модель**: `rerank-2.5`
- Dedicated cross-encoder API
- **Blending**: `0.5 * original_score + 0.5 * voyage_score`
- До 20 чанков, до 4000 символов на чанк

### 4.6 Intent-Aware Reranking (`retrieval.ts`)

Применяется ПЕРЕД LLM/Voyage reranking:

1. **Режимный бустинг**: +15% для чанков целевого режима, -15% для противоположного
2. **Intent бустинг**: +10% для чанков с тегами, соответствующими интенту
3. **Tier-weighted reranking**: веса по типу документа:
   - `законодательство`: x1.25
   - `положения`: x1.15
   - `стандарт`, `223-фз`, `вне 223-фз`: x1.10
   - `обучение`, `методика`, `матрица полномочий`: x1.05
   - `реестр`: x0.95
   - `справочники`, `форма`: x0.90

### 4.7 Фильтрация по релевантности (`filterByRelevance`)

- **Minimum threshold**: similarity >= 0.35
- **Cliff ratio**: каждый следующий результат должен быть >= 60% от предыдущего
- **Relaxed cliff**: если < 3 результатов прошли строгий фильтр -> >= 50% от лучшего
- **Max chunks**: 15
- **Low confidence flag**: если лучший результат < 0.35 -> помечается как low confidence

### 4.8 Post-processing

1. **Relationship expansion** (`relationships.ts`):
   - Находит связанные документы (parent/child/related)
   - Pre-filter по релевантности (keyword scoring по filename + tags)
   - Parents получают бонус +20, related +10
   - До 4 связанных источников, до 6 expansion-чанков

2. **Knowledge Graph context**: текстовое описание найденных сущностей и связей

3. **Chunk images loading**: загрузка изображений из bucket `chunk-images` по `image_paths[]`

## 5. Generation (Генерация ответа)

### 5.1 System Prompt

Собирается из:
- Anti-prompt-injection policy
- Режимные правила (223-ФЗ / вне 223-ФЗ)
- Формат ответа (таблицы, полнота, цитирование)
- Low-confidence warning (если retrieval слабый)
- Directives из реестра
- Uploaded document instructions (по document intent)
- RAG-контекст в XML: `<documents>...</documents>`
- Загруженные документы: `<uploaded_documents>...</uploaded_documents>`

### 5.2 Модель генерации

- **Основная**: `gemini-3-flash-preview` (Google)
- **Streaming**: через `@google/genai` SDK
- **System instruction**: весь system prompt передается как `systemInstruction`

### 5.3 Conversation Memory (`memory.ts`)

- Загрузка последних 50 сообщений
- При превышении 25000 токенов -> background summarization (Gemini Flash Lite)
- Summary хранится в `conversations.summary`
- Старые сообщения удаляются после суммаризации
- Сохранение последних 10 сообщений + summary

## 6. Индексы и оптимизации

### PostgreSQL индексы

| Индекс | Таблица | Тип | Назначение |
|--------|---------|-----|-----------|
| `chunks_embedding_idx` | chunks | IVFFlat (lists=100) | Векторный поиск (cosine) |
| `chunks_fts_idx` | chunks | GIN | Полнотекстовый поиск (Russian) |
| `chunks_fts_simple_idx` | chunks | GIN | Полнотекстовый поиск (Simple) |
| `chunks_tags_idx` | chunks | GIN | Фильтрация по тегам |
| `chunks_source_id_idx` | chunks | B-tree | Каскадное удаление |
| `idx_kg_entities_embedding` | kg_entities | HNSW (m=16, ef=64) | Векторный поиск сущностей |
| `idx_kg_entities_canonical` | kg_entities | B-tree | Поиск по имени |
| `idx_kg_relations_source/target` | kg_relations | B-tree | Обход графа |

### API Rate Limiting

- Google API: concurrency limiter (`withGoogleApiLimit`)
- Voyage API: прямой HTTP-вызов
- Redis rate limiting для пользовательских запросов

## 7. Стек технологий

| Компонент | Технология |
|-----------|-----------|
| Frontend | Next.js 15, React 19, Tailwind CSS 4 |
| Backend API | Next.js API Routes (App Router) |
| База данных | Supabase (PostgreSQL + pgvector) |
| Векторный поиск | pgvector IVFFlat / HNSW |
| Embeddings | Gemini Embedding 2 Preview (1536d, multimodal) |
| LLM (generation) | Gemini 3 Flash Preview |
| LLM (classification) | Gemini 3.1 Flash Lite Preview |
| LLM (agentic RAG) | Gemini 2.5 Flash |
| LLM (reranking) | Gemini 3.1 Flash Lite / Voyage rerank-2.5 |
| Document parsing | mammoth, pdf-parse, ExcelJS, JSZip, Gemini Vision OCR |
| Кеш / Rate limit | Redis (ioredis) |
| File storage | Supabase Storage |
| Deployment | Vercel |
| AI SDK | Vercel AI SDK (`ai` package) + `@google/genai` |
