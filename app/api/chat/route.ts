import { NextRequest, NextResponse } from "next/server";
import { google } from "@/app/lib/google-ai";
import { streamText, type CoreMessage } from "ai";
import { multiQuerySearch, hybridSearch, filterByRelevance, intentAwareRerank, fetchChunksBySection, fetchChunksByDocument } from "@/app/lib/retrieval";
import { classifyIntent } from "@/app/lib/intent-classifier";
import { loadConversationContext, saveMessage } from "@/app/lib/memory";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { unauthorizedResponse, notFound } from "@/app/lib/api-helpers";
import { classifyOffTopic, CATEGORY_LABELS, type OffTopicCategory } from "@/app/lib/off-topic-classifier";
import { notifyOffTopic } from "@/app/lib/telegram";
import { logError } from "@/app/lib/error-logger";
import { extractSearchHints, detectSectionReference, detectDocumentReference } from "@/app/lib/query-analyzer";

export const runtime = "nodejs";

const MAX_UPLOADED_DOC_CHARS = 50000;
const MAX_CHUNK_IMAGES = 3; // Max images to include per chunk in prompt
const MAX_TOTAL_IMAGES = 12; // Max total images in entire prompt

export async function POST(req: NextRequest) {
 try {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return unauthorizedResponse();
  }

  const { messages, conversationId, attachedDocuments } = await req.json();

  if (conversationId && !isAdminCode(invite.code)) {
    const supabase = createServiceClient();
    const { data: conv } = await supabase
      .from("conversations")
      .select("invite_code_id")
      .eq("id", conversationId)
      .single();

    if (!conv || conv.invite_code_id !== invite.id) {
      return notFound("Диалог не найден");
    }
  }

  const userMessage = messages[messages.length - 1];
  const hasAttachments = Array.isArray(attachedDocuments) && attachedDocuments.length > 0;

  let searchQuery = userMessage.content;
  if (hasAttachments && searchQuery.length < 60) {
    const docPreview = attachedDocuments
      .map((d: { filename: string; markdown: string }) => d.markdown.slice(0, 300))
      .join(" ");
    searchQuery = `${searchQuery} ${docPreview}`.slice(0, 1000);
  }

  const searchHints = extractSearchHints(userMessage.content);
  const sectionRef = detectSectionReference(userMessage.content);
  const docRef = detectDocumentReference(userMessage.content);

  const [, contextResult, intentResult, searchResults, offTopicResult, sectionResults, docResults] = await Promise.all([
    conversationId
      ? saveMessage(conversationId, "user", userMessage.content)
      : Promise.resolve(),
    conversationId
      ? loadConversationContext(conversationId)
      : Promise.resolve(null),
    classifyIntent(searchQuery),
    multiQuerySearch(searchQuery, 20, searchHints),
    classifyOffTopic(userMessage.content, messages.slice(0, -1)),
    sectionRef ? fetchChunksBySection(sectionRef) : Promise.resolve([]),
    docRef ? fetchChunksByDocument(docRef) : Promise.resolve([]),
  ]);

  // Off-topic handling (unchanged)
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

  // Merge section-lookup and document-lookup results with search results (dedup by id)
  let combinedResults = searchResults;
  const existingIds = new Set(searchResults.map((r) => r.id));

  if (sectionResults.length > 0) {
    const newSectionResults = sectionResults.filter((r) => !existingIds.has(r.id));
    for (const r of newSectionResults) existingIds.add(r.id);
    combinedResults = [...newSectionResults, ...combinedResults];
    console.log(`[chat] Section lookup added ${newSectionResults.length} new chunks`);
  }

  if (docResults.length > 0) {
    const newDocResults = docResults.filter((r) => !existingIds.has(r.id));
    for (const r of newDocResults) existingIds.add(r.id);
    combinedResults = [...combinedResults, ...newDocResults];
    console.log(`[chat] Document lookup added ${newDocResults.length} new chunks`);
  }

  // ── Intent-aware supplementary search ──
  // When intent classifier detected a specific fz_type or search_tags,
  // check if current results already contain matching chunks.
  // If not, run a targeted filtered search to fill the gap.
  if (intentResult.confidence >= 0.5) {
    const targetTags: string[] = [];

    if (intentResult.fz_type === "223") targetTags.push("223-фз");
    if (intentResult.fz_type === "non-223") targetTags.push("вне 223-фз");

    // Also add intent-specific tags
    const intentTagMap: Record<string, string[]> = {
      pricing: ["ценообразование"],
      authority: ["матрица полномочий"],
      regulation: ["законодательство"],
      contract: ["договоры"],
      system: ["инструкции"],
    };
    const extraTags = intentTagMap[intentResult.intent];
    if (extraTags) targetTags.push(...extraTags);

    if (targetTags.length > 0) {
      // Check if any current result has at least one target tag
      const hasTargetCoverage = combinedResults.some((r) =>
        r.tags.some((t) => targetTags.includes(t.toLowerCase()))
      );

      if (!hasTargetCoverage) {
        console.log(`[chat] Intent supplementary search: no results with tags [${targetTags.join(", ")}], fetching...`);
        const supplementary = await hybridSearch(searchQuery, 10, targetTags);
        const newSupplementary = supplementary.filter((r) => !existingIds.has(r.id));
        for (const r of newSupplementary) existingIds.add(r.id);
        combinedResults = [...combinedResults, ...newSupplementary];
        console.log(`[chat] Intent supplementary search added ${newSupplementary.length} new chunks`);
      }
    }
  }

  // Rerank and filter
  const rerankedResults = intentAwareRerank(combinedResults, intentResult);
  const { results: relevantChunks, lowConfidence } = filterByRelevance(rerankedResults);

  // ── NEW: Load chunk images from Supabase Storage ──
  const supabase = createServiceClient();
  let totalImagesIncluded = 0;

  interface ChunkWithImages {
    content: string;
    source_filename: string;
    chunk_index: number;
    similarity: number;
    imageBase64: Array<{ base64: string; mimeType: string }>;
  }

  const chunksWithImages: ChunkWithImages[] = await Promise.all(
    relevantChunks.map(async (chunk) => {
      const imageBase64: Array<{ base64: string; mimeType: string }> = [];

      if (chunk.image_paths && chunk.image_paths.length > 0 && totalImagesIncluded < MAX_TOTAL_IMAGES) {
        const pathsToLoad = chunk.image_paths.slice(0, MAX_CHUNK_IMAGES);

        for (const path of pathsToLoad) {
          if (totalImagesIncluded >= MAX_TOTAL_IMAGES) break;

          try {
            const { data, error } = await supabase.storage
              .from("chunk-images")
              .download(path);

            if (error || !data) {
              console.error(`[chat] Failed to download image ${path}:`, error);
              continue;
            }

            const arrayBuffer = await data.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString("base64");
            const ext = path.split(".").pop() || "png";
            const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

            imageBase64.push({ base64, mimeType });
            totalImagesIncluded++;
          } catch (e) {
            console.error(`[chat] Error loading image ${path}:`, e);
          }
        }
      }

      return {
        content: chunk.content,
        source_filename: chunk.source_filename,
        chunk_index: chunk.chunk_index,
        similarity: chunk.similarity,
        imageBase64,
      };
    })
  );

  console.log(`[chat] Loaded ${totalImagesIncluded} images for ${chunksWithImages.length} chunks`);

  // ── Build RAG context with text (images will be in multimodal messages) ──
  const ragContext = chunksWithImages.length
    ? `<documents>\n${chunksWithImages
        .map(
          (r, i) =>
            `<document id="${i + 1}" filename="${r.source_filename}" chunk="${r.chunk_index}" similarity="${r.similarity.toFixed(2)}" has_screenshots="${r.imageBase64.length > 0 ? "yes" : "no"}">\n${r.content}\n</document>`
        )
        .join("\n")}\n</documents>`
    : "";

  // Uploaded documents context (unchanged)
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

  const lowConfidenceWarning = lowConfidence
    ? `\n\n⚠️ ВНИМАНИЕ: Найденные документы имеют НИЗКУЮ релевантность к вопросу пользователя. Скорее всего, ответа в базе знаний нет. Сообщи об этом пользователю явно.`
    : "";

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

  // ── NEW: Screenshot instructions for the model ──
  const screenshotInstructions = totalImagesIncluded > 0
    ? `

СКРИНШОТЫ ИЗ ИНСТРУКЦИЙ:
К некоторым документам приложены скриншоты интерфейса CRM-системы. Они идут после текста соответствующего документа как изображения.
- Если скриншот помогает ответить на вопрос — опиши, что на нём изображено (какие кнопки, меню, поля)
- Ссылайся на скриншоты в ответе: «Как показано на скриншоте из документа N...»
- Не описывай скриншоты, если они не относятся к вопросу пользователя`
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
Ответ: В загруженных документах отсутствует информация о зарплатах сотрудников. Доступные документы содержат информацию о процедурах закупок и нормативных требованиях. Для получения данных о зарплатах рекомендую обратиться в отдел кадров.${uploadedDocsInstructions}${screenshotInstructions}${lowConfidenceWarning}

=== РЕЕСТР СПУ (Список Потенциальных Участников) ===

В базе знаний загружен файл «Реестр СПУ контрагенты виды работ объекты». Это реестр потенциальных участников закупочных процедур СГК, содержащий 874 уникальных контрагента по 68 видам работ на 32 объектах трёх бизнес-единиц (Енисейская ТГК, Кузбассэнерго, СГК-Алтай).

КОГДА ИСПОЛЬЗОВАТЬ:
Обращайся к реестру СПУ, если пользователь спрашивает о подрядчиках, поставщиках, исполнителях, контрагентах, участниках закупки, организациях, которые выполняют определённые виды работ, или кто может выполнить работу на конкретном объекте.

КАК РАБОТАТЬ С ДАННЫМИ:
1. Определи из запроса: вид работ/услуг, объект (ГРЭС/ТЭЦ/теплосеть), бизнес-единицу.
2. Найди в реестре записи, соответствующие этим параметрам.
3. Фильтрация по статусу:
   РЕЖИМ ПО УМОЛЧАНИЮ: Если пользователь просто ищет подрядчиков/контрагентов — показывай ТОЛЬКО записи со статусами «ТКП», «ТКП MIN», «ТКП Инициатора».
   РАСШИРЕННЫЙ РЕЖИМ: Если пользователь явно просит показать компании без статуса, отказавшихся, не ответивших, или использует формулировки вроде «все компании», «кто отказался», «без ТКП», «не подтвердившие», «с отказом», «не обладающие статусом» — покажи ВСЕ записи из реестра, разделив на два блока:
     Блок 1 (основной): контрагенты со статусами ТКП / ТКП MIN / ТКП Инициатора.
     Блок 2 (дополнительный, с предупреждением): контрагенты со статусами ОТКАЗ, Нет ответа, Недозвон, Отмена запроса. Перед этим блоком выведи пояснение: «Следующие компании числятся в реестре, но не подтвердили готовность к участию в закупке:».
4. Ранжируй результаты: внутри каждого блока — сначала ТКП, затем ТКП MIN, затем ТКП Инициатора; во втором блоке — по алфавиту.
5. Для каждого контрагента указывай: наименование, ИНН, вид работ, объект, статус.

ФОРМАТ ОТВЕТА:
Если найдено 1–5 контрагентов, перечисли всех с полными данными.
Если найдено 6–15, сгруппируй по статусу (ТКП / ТКП MIN / ТКП Инициатора) и укажи количество.
Если найдено >15, укажи общее количество, покажи топ-5 и предложи уточнить запрос.
В расширенном режиме: сначала покажи основной блок (ТКП) по обычным правилам, затем отдельной секцией — компании без подтверждённого статуса с указанием причины (ОТКАЗ / Нет ответа / Недозвон / Отмена запроса).
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

=== УЧЕБНЫЕ КУРСЫ ===

В базе знаний загружены учебные курсы:
1) «Закупки по 223-ФЗ» — способы закупок, пороги, роли, ЗКО, НМЦД
2) «Закупки вне 223-ФЗ» — стандарт СГК 2.0, матрица полномочий, 12 фаз закупки
3) «Планирование закупок» — SAP-коды, сроки, ценообразование

КОГДА ИСПОЛЬЗОВАТЬ:
- Когда пользователь спрашивает «как провести закупку», «какой порядок», «с чего начать»
- Когда вопрос касается обучения новых сотрудников или onboarding
- Когда нужно объяснить разницу между способами закупок
Сочетай информацию из курсов с цитатами из нормативных документов.

${ragContext || "В базе знаний не найдено релевантных документов по данному запросу. Сообщи пользователю, что по его вопросу документы не найдены."}

${uploadedDocsContext}`;

  // ── Build multimodal messages for the model ──
  // System prompt goes as system, then we build user/assistant messages
  // with images interleaved

  const modelMessages: CoreMessage[] = [];

  // Add context messages
  const ctxMsgs = contextMessages.filter((m) => m.role !== "system");
  if (ctxMsgs.length > 0) {
    for (const m of ctxMsgs) {
      if (m.role === "user") {
        modelMessages.push({ role: "user" as const, content: m.content as string });
      } else if (m.role === "assistant") {
        modelMessages.push({ role: "assistant" as const, content: m.content as string });
      }
    }
  } else {
    // Use messages from request (excluding last, we'll add it with images)
    for (let k = 0; k < messages.length - 1; k++) {
      const msg = messages[k];
      if (msg.role === "user") {
        modelMessages.push({ role: "user" as const, content: msg.content as string });
      } else if (msg.role === "assistant") {
        modelMessages.push({ role: "assistant" as const, content: msg.content as string });
      }
    }
  }

  // Build the final user message with multimodal content (text + chunk images)
  if (totalImagesIncluded > 0) {
    // Multimodal message: text + images from relevant chunks
    const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];

    // User's question text
    parts.push({ type: "text", text: userMessage.content });

    // Append chunk images with labels
    for (let ci = 0; ci < chunksWithImages.length; ci++) {
      const cw = chunksWithImages[ci];
      if (cw.imageBase64.length > 0) {
        parts.push({
          type: "text",
          text: `\n[Скриншоты из документа "${cw.source_filename}", чанк ${cw.chunk_index}]:`,
        });
        for (const img of cw.imageBase64) {
          parts.push({
            type: "image",
            image: `data:${img.mimeType};base64,${img.base64}`,
          });
        }
      }
    }

    modelMessages.push({
      role: "user",
      content: parts,
    });
  } else {
    // Plain text message (no images in chunks)
    const lastModel = modelMessages[modelMessages.length - 1];
    if (
      !lastModel ||
      lastModel.role !== "user" ||
      lastModel.content !== userMessage.content
    ) {
      modelMessages.push({
        role: "user",
        content: userMessage.content,
      });
    }
  }

  const sourceFilenames = [...new Set(relevantChunks.map((r) => r.source_filename))];

  // ── Build proxy URLs for chunk images to pass to frontend ──
  interface ChunkImageUrl {
    url: string;
    source: string;
    chunk: number;
  }
  const chunkImageUrls: ChunkImageUrl[] = [];
  for (const cw of chunksWithImages) {
    if (cw.imageBase64.length === 0) continue;
    const originalChunk = relevantChunks.find(
      (c) => c.source_filename === cw.source_filename && c.chunk_index === cw.chunk_index
    );
    if (!originalChunk?.image_paths) continue;
    const pathsToProxy = originalChunk.image_paths.slice(0, MAX_CHUNK_IMAGES);
    for (const path of pathsToProxy) {
      chunkImageUrls.push({
        url: `/api/chunk-image?path=${encodeURIComponent(path)}&token=${encodeURIComponent(invite.code)}`,
        source: cw.source_filename,
        chunk: cw.chunk_index,
      });
    }
  }

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
        if (totalImagesIncluded > 0) metadata.imagesUsed = totalImagesIncluded;
        if (chunkImageUrls.length > 0) metadata.chunkImages = chunkImageUrls;
        await saveMessage(conversationId, "assistant", text,
          Object.keys(metadata).length > 0 ? metadata : undefined
        );
      }
    },
  });

  const responseHeaders: Record<string, string> = {
    "X-Sources": encodeURIComponent(JSON.stringify(sourceFilenames)),
  };
  if (chunkImageUrls.length > 0) {
    responseHeaders["X-Chunk-Images"] = encodeURIComponent(JSON.stringify(chunkImageUrls));
  }

  return result.toDataStreamResponse({ headers: responseHeaders });
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
