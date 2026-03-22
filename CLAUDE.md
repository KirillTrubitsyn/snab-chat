# СнабЧат — RAG-ассистент Дирекции по закупкам

## Обзор проекта

Next.js 15 приложение — чат-бот на базе RAG (Retrieval-Augmented Generation), отвечающий строго по загруженным документам (DOCX, PDF, XLSX). Использует Supabase (PostgreSQL + pgvector) для хранения и поиска, Google Gemini для генерации и эмбеддингов.

## Технологический стек

- **Фреймворк:** Next.js 15 (App Router)
- **LLM:** Google Gemini 3 Flash (`gemini-3-flash`) через `@ai-sdk/google` + Vercel AI SDK
- **Эмбеддинги:** `gemini-embedding-2-preview` (1536 dim) через `@google/genai`
- **БД:** Supabase PostgreSQL + pgvector
- **Парсинг:** mammoth (DOCX), pdf-parse (PDF), xlsx (Excel)
- **Стриминг:** Vercel AI SDK `streamText` + data stream protocol

## Архитектура

```
Пользователь → Chat.tsx (React) → /api/chat (Next.js API Route)
                                      ├── hybridSearch() → Supabase RPC `hybrid_search`
                                      ├── filterByRelevance() → порог 0.35, макс 8 чанков
                                      ├── loadConversationContext() → история + резюме
                                      └── streamText(gemini-3-flash) → стриминг ответа
```

## Структура файлов

```
app/
├── api/
│   ├── chat/route.ts          # Главный эндпоинт чата (RAG + стриминг)
│   ├── parse/route.ts         # Парсинг загруженного файла → markdown + теги + чанки
│   ├── ingest/route.ts        # Индексация: чанкинг → эмбеддинг → Supabase
│   ├── search/route.ts        # Поисковый эндпоинт (для отладки)
│   ├── sources/route.ts       # CRUD для загруженных документов
│   └── conversations/
│       ├── route.ts           # CRUD для диалогов
│       └── messages/route.ts  # Получение сообщений диалога
├── components/
│   └── Chat.tsx               # Основной UI-компонент (чат, сайдбар, загрузка файлов)
├── lib/
│   ├── retrieval.ts           # Гибридный поиск + фильтрация по релевантности
│   ├── embeddings.ts          # Google Gemini Embedding API
│   ├── chunking.ts            # Разбивка markdown на чанки (9000 символов)
│   ├── parser.ts              # Парсинг DOCX/PDF/XLSX → markdown
│   ├── memory.ts              # Управление контекстом диалога + суммаризация
│   ├── tagging.ts             # Автоматическая генерация тегов для документов
│   ├── google-ai.ts           # Инициализация Google AI SDK
│   └── supabase.ts            # Supabase клиент (service + browser)
└── globals.css                # Все стили приложения
```

## Ключевые параметры RAG-пайплайна

| Параметр | Значение | Файл |
|----------|----------|------|
| Модель чата | `gemini-3-flash` | `api/chat/route.ts` |
| Модель эмбеддинга | `gemini-embedding-2-preview` | `lib/embeddings.ts` |
| Размерность эмбеддинга | 1536 | `lib/embeddings.ts` |
| Размер чанка | 9000 символов | `lib/chunking.ts` |
| Мин. размер чанка | 500 символов | `lib/chunking.ts` |
| Гибридный поиск: вес вектора | 0.7 | `lib/retrieval.ts` |
| Гибридный поиск: вес FTS | 0.3 | `lib/retrieval.ts` |
| Макс. чанков из поиска | 20 (запрос) → 8 (после фильтрации) | `lib/retrieval.ts` |
| Порог релевантности | 0.35 | `lib/retrieval.ts` |
| Коэффициент обрыва | 0.7 | `lib/retrieval.ts` |
| Temperature | 0 | `api/chat/route.ts` |
| Токен-бюджет памяти | 30000 | `lib/memory.ts` |
| Порог суммаризации | 25000 | `lib/memory.ts` |
| Недавние сообщения (сохранять) | 10 | `lib/memory.ts` |

## Принципы ответов модели

Системный промпт настроен так, чтобы модель:
1. Отвечала ТОЛЬКО по предоставленным документам (XML-формат `<documents>`)
2. Цитировала источники в формате `[doc:N]` после каждого утверждения
3. Явно указывала, когда информация отсутствует в базе знаний
4. Не использовала общие знания для заполнения пробелов
5. При низкой релевантности (`lowConfidence`) предупреждала пользователя

## Переменные окружения

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GOOGLE_API_KEY=AIza...
```

## Команды

```bash
npm run dev      # Запуск dev-сервера
npm run build    # Продакшн-сборка
npm run start    # Продакшн-сервер
npm run lint     # Линтер
```

## База данных Supabase

Схема описана в `supabase/schema.sql`. Для первоначальной настройки выполните SQL-скрипт в Supabase SQL Editor.

Таблицы: `sources`, `chunks` (с pgvector), `conversations`, `messages`.
RPC-функция: `hybrid_search` — гибридный поиск по вектору + полнотекстовый.

## Важные моменты при доработке

- **НЕ менять** формат системного промпта без тестирования — он тщательно настроен против галлюцинаций
- Фильтрация релевантности (`filterByRelevance`) — критический компонент, пороги подбирались эмпирически
- Контекст передаётся модели в XML-формате `<documents>` — это помогает модели различать источники
- Источники в UI показываются только из релевантных отфильтрованных чанков (не из всех 20)
- Стриминг реализован вручную (два пути: новый диалог + существующий), а не через стандартный `useChat`
