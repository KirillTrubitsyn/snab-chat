import { NextRequest, NextResponse } from "next/server";
import { google } from "@/app/lib/google-ai";
import { streamText } from "ai";
import { multiQuerySearch, filterByRelevance } from "@/app/lib/retrieval";
import { loadConversationContext, saveMessage } from "@/app/lib/memory";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { classifyOffTopic, CATEGORY_LABELS, type OffTopicCategory } from "@/app/lib/off-topic-classifier";
import { notifyOffTopic } from "@/app/lib/telegram";
import { logError } from "@/app/lib/error-logger";
import { extractSearchHints } from "@/app/lib/query-analyzer";

export const runtime = "nodejs";

const MAX_UPLOADED_DOC_CHARS = 50000;

export async function POST(req: NextRequest) {
 try {
  // Проверка авторизации
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json({ error: "Требуется инвайт-код" }, { status: 401 });
  }

  const { messages, conversationId, attachedDocuments } = await req.json();

  // Проверяем принадлежность диалога (если не админ)
  if (conversationId && !isAdminCode(invite.code)) {
    const supabase = createServiceClient();
    const { data: conv } = await supabase
      .from("conversations")
      .select("invite_code_id")
      .eq("id", conversationId)
      .single();

    if (!conv || conv.invite_code_id !== invite.id) {
      return NextResponse.json({ error: "Диалог не найден" }, { status: 404 });
    }
  }

  const userMessage = messages[messages.length - 1];
  const hasAttachments = Array.isArray(attachedDocuments) && attachedDocuments.length > 0;

  // If user message is generic and has attachments, enrich search query with doc content
  let searchQuery = userMessage.content;
  if (hasAttachments && searchQuery.length < 60) {
    const docPreview = attachedDocuments
      .map((d: { filename: string; markdown: string }) => d.markdown.slice(0, 300))
      .join(" ");
    searchQuery = `${searchQuery} ${docPreview}`.slice(0, 1000);
  }

  // Extract tag hints from query for filtered search
  const searchHints = extractSearchHints(userMessage.content);

  // Run save, context load, RAG search, and off-topic classification in parallel
  const [, contextResult, searchResults, offTopicResult] = await Promise.all([
    conversationId
      ? saveMessage(conversationId, "user", userMessage.content)
      : Promise.resolve(),
    conversationId
      ? loadConversationContext(conversationId)
      : Promise.resolve(null),
    multiQuerySearch(searchQuery, 20, searchHints),
    classifyOffTopic(userMessage.content, messages.slice(0, -1)),
  ]);

  // Обработка нецелевых запросов: логируем + блокируем
  if (offTopicResult.isOffTopic && !isAdminCode(invite.code)) {
    const supabase = createServiceClient();
    const inviteCodeId = invite.id.startsWith("admin-") ? null : invite.id;
    const categoryLabel = CATEGORY_LABELS[offTopicResult.category as OffTopicCategory] ?? offTopicResult.category;

    console.log(`[OffTopic] Blocking off-topic query: "${userMessage.content.slice(0, 80)}" (${offTopicResult.category})`);

    const refusalMessage = `Я — СнабЧат, ассистент Дирекции по закупкам. К сожалению, ваш вопрос не относится к моей области компетенции (закупки, снабжение, договоры, нормативные документы).

Я могу помочь с вопросами о:
- Закупках, тендерах, аукционах
- Договорах и контрактах
- Нормативных документах и регламентах
- Поставках и логистике
- Работе с поставщиками

Пожалуйста, задайте вопрос по теме закупок и снабжения.`;

    // Await: сохраняем в БД + ТГ-уведомление + отказ в историю диалога
    // (await обязателен — Vercel убивает функцию после return)
    await Promise.all([
      supabase.from("off_topic_queries").insert({
        invite_code_id: inviteCodeId,
        user_name: invite.name,
        organization: invite.organization ?? null,
        category: offTopicResult.category,
        query_text: userMessage.content.slice(0, 5000),
      }).then(({ error }) => {
        if (error) console.error("[OffTopic] DB insert error:", error.message);
        else console.log("[OffTopic] Saved to off_topic_queries");
      }),
      notifyOffTopic(invite.name, userMessage.content, offTopicResult.category, categoryLabel, invite.organization),
      conversationId
        ? saveMessage(conversationId, "assistant", refusalMessage, { offTopic: true })
        : Promise.resolve(),
    ]).catch((e) => console.error("[OffTopic] save error:", e));

    // Возвращаем отказ в формате Vercel AI SDK data stream protocol
    const encoded = JSON.stringify(refusalMessage);
    const streamBody = `0:${encoded}\nd:{"finishReason":"stop"}\n`;

    return new Response(streamBody, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Sources": encodeURIComponent(JSON.stringify([])),
        "X-Off-Topic": "true",
      },
    });
  }

  const contextMessages: { role: string; content: string }[] =
    contextResult?.messages ?? [];

  // Phase 1: Filter by relevance
  const { results: relevantChunks, lowConfidence } = filterByRelevance(searchResults);

  // Phase 3a: Structured XML context format
  const ragContext = relevantChunks.length
    ? `<documents>\n${relevantChunks
        .map(
          (r, i) =>
            `<document id="${i + 1}" filename="${r.source_filename}" chunk="${r.chunk_index}" similarity="${r.similarity.toFixed(2)}">\n${r.content}\n</document>`
        )
        .join("\n")}\n</documents>`
    : "";

  // Phase 3a-bis: Build uploaded documents context
  let uploadedDocsContext = "";
  if (hasAttachments) {
    const docs = attachedDocuments.map(
      (d: { filename: string; markdown: string }, i: number) => {
        const content = d.markdown.length > MAX_UPLOADED_DOC_CHARS
          ? d.markdown.slice(0, MAX_UPLOADED_DOC_CHARS) + "\n\n[... документ обрезан ...]"
          : d.markdown;
        return `<uploaded_document id="${i + 1}" filename="${d.filename}">\n${content}\n</uploaded_document>`;
      }
    );
    uploadedDocsContext = `<uploaded_documents>\n${docs.join("\n")}\n</uploaded_documents>`;
  }

  // Phase 3b: System prompt with citation protocol and few-shot examples
  const lowConfidenceWarning = lowConfidence
    ? `\n\n⚠️ ВНИМАНИЕ: Найденные документы имеют НИЗКУЮ релевантность к вопросу пользователя. Скорее всего, ответа в базе знаний нет. Сообщи об этом пользователю явно.`
    : "";

  // Additional instructions when user uploaded documents for compliance checking
  const uploadedDocsInstructions = hasAttachments
    ? `

РЕЖИМ ПРОВЕРКИ ДОКУМЕНТОВ:
Пользователь загрузил ${attachedDocuments.length} документ(ов) для проверки. Эти документы находятся в секции <uploaded_documents>.
Регламенты, стандарты и нормативные документы из базы знаний находятся в секции <documents>.

ТВОЯ ЗАДАЧА:
1. Тщательно проанализировать загруженные документы (<uploaded_documents>)
2. Сравнить их содержание с регламентами и стандартами из базы знаний (<documents>)
3. Выявить:
   - Соответствия и несоответствия требованиям регламентов
   - Отсутствующие обязательные пункты или разделы
   - Нарушения процедур, сроков, форматов
   - Возможные противоречия с законодательством (если применимо)
4. Ссылайся на конкретные пункты/разделы как загруженного документа, так и регламентов из базы знаний
5. Если в базе знаний не найдено подходящих регламентов — сообщи об этом явно
6. Структурируй ответ: сначала общая оценка, затем детальный анализ по пунктам

ФОРМАТ ОТВЕТА ПРИ ПРОВЕРКЕ:
- Начни с краткого резюме (соответствует / частично соответствует / не соответствует)
- Используй разделы: "Соответствия", "Несоответствия", "Рекомендации"
- Приводи дословные цитаты из обоих источников для обоснования`
    : "";

  const systemPrompt = `Ты СнабЧат — ИИ-ассистент Дирекции по закупкам. Ты помогаешь сотрудникам с вопросами о закупках, снабжении, договорах, нормативных документах и внутренних процедурах.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА (ОБЯЗАТЕЛЬНЫ К ИСПОЛНЕНИЮ):
1. Ты ДОЛЖЕН отвечать ИСКЛЮЧИТЕЛЬНО на основе предоставленных ниже документов (<documents>). Это твой ЕДИНСТВЕННЫЙ источник информации.
2. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать свои общие знания, обучающие данные или делать предположения для дополнения ответа. Даже если ты "знаешь" что-то по теме — НЕ используй это.
3. Если информации в документах НЕДОСТАТОЧНО — прямо укажи это. НЕ пытайся заполнить пробелы.
4. Если вопрос частично покрыт документами — ответь только на покрытую часть и явно укажи, что остальное в документах отсутствует.
5. При цитировании — приводи ДОСЛОВНЫЕ цитаты из документов.
6. Перед каждым утверждением мысленно проверь: есть ли для него ПРЯМОЕ подтверждение в <documents>? Если нет — НЕ включай его в ответ.
7. НЕ вставляй ссылки на источники вида [doc:N] в текст ответа. Источники отображаются отдельно в интерфейсе.

ФОРМАТ ОТВЕТА:
- Используй Markdown для форматирования
- Для дословных цитат используй формат: > "цитата"
- Деловой, но дружелюбный тон
- НЕ добавляй [doc:1], [doc:2] и подобные ссылки в текст
- Когда пользователь просит составить таблицу с расчётами, итогами или формулами — используй стандартные Excel-формулы прямо в ячейках markdown-таблицы. Например: =SUM(B2:B10), =A2*B2, =AVERAGE(C2:C5), =B2/C2*100. Формулы должны ссылаться на правильные ячейки Excel (колонки A, B, C... и строки 1, 2, 3..., где строка 1 — заголовок). Пользователь сможет скачать таблицу в Excel с рабочими формулами.

ПРИМЕР ОТВЕТА:
Вопрос: Какой срок рассмотрения заявок?
Ответ: Согласно регламенту, срок рассмотрения заявок составляет 10 рабочих дней. При этом комиссия вправе продлить срок на 5 дней при наличии обоснования.

> "Заявки участников рассматриваются в течение 10 (десяти) рабочих дней с даты окончания приёма"

ПРИМЕР ОТКАЗА (когда информации нет):
Вопрос: Какова средняя зарплата в отделе закупок?
Ответ: В загруженных документах отсутствует информация о зарплатах сотрудников. Доступные документы содержат информацию о процедурах закупок и нормативных требованиях. Для получения данных о зарплатах рекомендую обратиться в отдел кадров.${uploadedDocsInstructions}${lowConfidenceWarning}

=== РЕЕСТР СПУ (Список Потенциальных Участников) ===

В базе знаний загружен файл «Реестр СПУ контрагенты виды работ объекты». Это реестр потенциальных участников закупочных процедур СГК, содержащий 874 уникальных контрагента по 68 видам работ на 32 объектах трёх бизнес-единиц (Енисейская ТГК, Кузбассэнерго, СГК-Алтай).

КОГДА ИСПОЛЬЗОВАТЬ:
Обращайся к реестру СПУ, если пользователь спрашивает о подрядчиках, поставщиках, исполнителях, контрагентах, участниках закупки, организациях, которые выполняют определённые виды работ, или кто может выполнить работу на конкретном объекте.

КАК РАБОТАТЬ С ДАННЫМИ:
1. Определи из запроса: вид работ/услуг, объект (ГРЭС/ТЭЦ/теплосеть), бизнес-единицу.
2. Найди в реестре записи, соответствующие этим параметрам.
3. Отфильтруй по статусу: показывай ТОЛЬКО контрагентов со статусами «ТКП», «ТКП MIN», «ТКП Инициатора». НЕ показывай контрагентов со статусами «ОТКАЗ» (любой вид), «Нет ответа», «Недозвон», «Отмена запроса».
4. Ранжируй результаты: сначала ТКП, затем ТКП MIN, затем ТКП Инициатора.
5. Для каждого контрагента указывай: наименование, ИНН, вид работ, объект, статус.

ФОРМАТ ОТВЕТА:
Если найдено 1–5 контрагентов, перечисли всех с полными данными.
Если найдено 6–15, сгруппируй по статусу (ТКП / ТКП MIN / ТКП Инициатора) и укажи количество.
Если найдено >15, укажи общее количество, покажи топ-5 и предложи уточнить запрос.
Если ничего не найдено, сообщи об этом и предложи расширить поиск: другой вид работ, другой объект, другая БЕ.

НЕЧЁТКОЕ СООТВЕТСТВИЕ ВИДОВ РАБОТ:
Пользователи используют свободные формулировки. Сопоставляй их с категориями справочника:
«ремонт бульдозеров» / «бульдозерная техника» → Ремонт бульдозеров
«насосы» / «насосное оборудование» → Монтаж / ремонт насосного оборудования
«электрика» / «электромонтаж» → Электромонтажные работы
«проект» / «ПИР» → Проектирование
«обслуживание» / «ТО» / «сервис» → Техническое обслуживание
«строительство» / «СМР» → Общестроительные работы
«КИП» / «КИПиА» / «автоматика» → Монтаж / ремонт КИПиА
«котлы» / «котельное» → Монтаж / ремонт котлов
«турбины» / «турбинное» → Монтаж / ремонт турбинного оборудования

ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ:
Если пользователь указывает сумму закупки и объект, определи режим закупки (223-ФЗ или не 223-ФЗ) по листу «структура СГК» из того же файла и дополни ответ этой информацией.

ВАЖНО: Контактные данные (телефон, email) выводи только по прямому запросу пользователя. В обычном списке достаточно наименования, ИНН и статуса.

=== РАЗГРАНИЧЕНИЕ 223-ФЗ / НЕ 223-ФЗ ===

В базе знаний есть документы двух режимов закупок:
1) Закупки по 223-ФЗ (для юрлиц, зарегистрированных в реестре ЕИС).
2) Закупки не по 223-ФЗ (для ООО «СГК», ОСП «СибЭМ» и других структур, не подпадающих под 223-ФЗ).

ПРАВИЛА:
Если пользователь указывает конкретный объект или юрлицо, определи режим закупки по листу «структура СГК» из файла реестра СПУ.
Если пользователь спрашивает в общем (без указания объекта), отвечай по обоим режимам, чётко разграничивая: «По 223-ФЗ: …» и «Вне 223-ФЗ: …».
Раздел 03 базы знаний (Закупки по ФЗ) содержит документы для 223-ФЗ.
Раздел 04 базы знаний (Закупки не по ФЗ) содержит документы для режима вне 223-ФЗ.
НЕ смешивай эти режимы в одном ответе без явного разграничения.

=== ПРИОРИТЕТ ИСТОЧНИКОВ ===

При формировании ответа соблюдай иерархию источников:
Уровень 1 (высший): Законодательство (раздел 01: 223-ФЗ, подзаконные акты).
Уровень 2: Стандарты СГК (раздел 02), Положения о закупках (разделы 03, 04, 05).
Уровень 3: Инструкции и методики (раздел 06).
Уровень 4: Справочные материалы (разделы 07–12, включая реестр СПУ).

Если информация из разных уровней противоречит друг другу, приоритет у более высокого уровня.
При ответе указывай источник: «Согласно Положению о закупках…», «В соответствии с Инструкцией…».

${ragContext || "В базе знаний не найдено релевантных документов по данному запросу. Сообщи пользователю, что по его вопросу документы не найдены."}

${uploadedDocsContext}`;

  // Build messages for the model
  const modelMessages = [
    ...contextMessages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
  ];

  // Use messages from request if no context loaded
  if (modelMessages.length === 0) {
    modelMessages.push(
      ...messages.map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    );
  } else {
    // Make sure the latest user message is included
    const lastModel = modelMessages[modelMessages.length - 1];
    if (
      lastModel.role !== "user" ||
      lastModel.content !== userMessage.content
    ) {
      modelMessages.push({
        role: "user",
        content: userMessage.content,
      });
    }
  }

  // Build source filenames from filtered relevant chunks (not all 20)
  const sourceFilenames = [...new Set(relevantChunks.map((r) => r.source_filename))];

  // Phase 3c: Stream response from Gemini
  const result = streamText({
    model: google("gemini-3-flash-preview"),
    system: systemPrompt,
    messages: modelMessages,
    temperature: 0,
    async onFinish({ text }) {
      if (conversationId) {
        const metadata: Record<string, unknown> = {};
        if (sourceFilenames.length > 0) metadata.sources = sourceFilenames;
        if (lowConfidence) metadata.lowConfidence = true;
        await saveMessage(conversationId, "assistant", text,
          Object.keys(metadata).length > 0 ? metadata : undefined
        );
      }
    },
  });

  return result.toDataStreamResponse({
    headers: {
      "X-Sources": encodeURIComponent(JSON.stringify(sourceFilenames)),
    },
  });
 } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logError({
      type: "chat",
      message: errMsg,
      endpoint: "/api/chat",
    }).catch(() => {});
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
 }
}
