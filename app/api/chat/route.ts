import { NextRequest, NextResponse } from "next/server";
import { google } from "@/app/lib/google-ai";
import { streamText } from "ai";
import { hybridSearch, filterByRelevance } from "@/app/lib/retrieval";
import { loadConversationContext, saveMessage } from "@/app/lib/memory";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";

export const runtime = "nodejs";

const MAX_UPLOADED_DOC_CHARS = 50000;

export async function POST(req: NextRequest) {
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

  // Run save, context load, and RAG search in parallel
  const [, contextResult, searchResults] = await Promise.all([
    conversationId
      ? saveMessage(conversationId, "user", userMessage.content)
      : Promise.resolve(),
    conversationId
      ? loadConversationContext(conversationId)
      : Promise.resolve(null),
    hybridSearch(searchQuery, 20),
  ]);

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

ПРИМЕР ОТВЕТА:
Вопрос: Какой срок рассмотрения заявок?
Ответ: Согласно регламенту, срок рассмотрения заявок составляет 10 рабочих дней. При этом комиссия вправе продлить срок на 5 дней при наличии обоснования.

> "Заявки участников рассматриваются в течение 10 (десяти) рабочих дней с даты окончания приёма"

ПРИМЕР ОТКАЗА (когда информации нет):
Вопрос: Какова средняя зарплата в отделе закупок?
Ответ: В загруженных документах отсутствует информация о зарплатах сотрудников. Доступные документы содержат информацию о процедурах закупок и нормативных требованиях. Для получения данных о зарплатах рекомендую обратиться в отдел кадров.${uploadedDocsInstructions}${lowConfidenceWarning}

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
        await saveMessage(conversationId, "assistant", text,
          sourceFilenames.length > 0 ? { sources: sourceFilenames } : undefined
        );
      }
    },
  });

  return result.toDataStreamResponse({
    headers: {
      "X-Sources": encodeURIComponent(JSON.stringify(sourceFilenames)),
    },
  });
}
