import { NextRequest } from "next/server";
import { google } from "@/app/lib/google-ai";
import { streamText, generateText } from "ai";
import { hybridSearch, filterByRelevance } from "@/app/lib/retrieval";
import { loadConversationContext, saveMessage } from "@/app/lib/memory";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { messages, conversationId } = await req.json();

  const userMessage = messages[messages.length - 1];

  // Run save, context load, and RAG search in parallel
  const [, contextResult, searchResults] = await Promise.all([
    conversationId
      ? saveMessage(conversationId, "user", userMessage.content)
      : Promise.resolve(),
    conversationId
      ? loadConversationContext(conversationId)
      : Promise.resolve(null),
    hybridSearch(userMessage.content, 20),
  ]);

  const contextMessages: { role: string; content: string }[] =
    contextResult?.messages ?? [];

  // Phase 1: Filter by relevance
  const { results: relevantChunks, lowConfidence } = filterByRelevance(searchResults);
  console.log("filterByRelevance:", relevantChunks.length, "chunks, lowConfidence =", lowConfidence);

  // Phase 3a: Structured XML context format
  const ragContext = relevantChunks.length
    ? `<documents>\n${relevantChunks
        .map(
          (r, i) =>
            `<document id="${i + 1}" filename="${r.source_filename}" chunk="${r.chunk_index}" similarity="${r.similarity.toFixed(2)}">\n${r.content}\n</document>`
        )
        .join("\n")}\n</documents>`
    : "";

  // Phase 3b: System prompt with citation protocol and few-shot examples
  const lowConfidenceWarning = lowConfidence
    ? `\n\n⚠️ ВНИМАНИЕ: Найденные документы имеют НИЗКУЮ релевантность к вопросу пользователя. Скорее всего, ответа в базе знаний нет. Сообщи об этом пользователю явно.`
    : "";

  const systemPrompt = `Ты СнабЧат — ИИ-ассистент Дирекции по закупкам. Ты помогаешь сотрудникам с вопросами о закупках, снабжении, договорах, нормативных документах и внутренних процедурах.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА (ОБЯЗАТЕЛЬНЫ К ИСПОЛНЕНИЮ):
1. Ты ДОЛЖЕН отвечать ИСКЛЮЧИТЕЛЬНО на основе предоставленных ниже документов (<documents>). Это твой ЕДИНСТВЕННЫЙ источник информации.
2. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать свои общие знания, обучающие данные или делать предположения для дополнения ответа. Даже если ты "знаешь" что-то по теме — НЕ используй это.
3. Если информации в документах НЕДОСТАТОЧНО — прямо укажи это. НЕ пытайся заполнить пробелы.
4. Если вопрос частично покрыт документами — ответь только на покрытую часть и явно укажи, что остальное в документах отсутствует.
5. КАЖДОЕ утверждение в ответе ДОЛЖНО содержать ссылку на источник в формате [doc:N], где N — id документа из контекста.
6. При цитировании — приводи ДОСЛОВНЫЕ цитаты из документов.
7. Перед каждым утверждением мысленно проверь: есть ли для него ПРЯМОЕ подтверждение в <documents>? Если нет — НЕ включай его в ответ.

ФОРМАТ ОТВЕТА:
- Каждое утверждение сопровождай ссылкой [doc:N]
- Для дословных цитат используй формат: > "цитата" [doc:N]
- Используй Markdown для форматирования
- Деловой, но дружелюбный тон

ПРИМЕР ОТВЕТА С ЦИТАТАМИ:
Вопрос: Какой срок рассмотрения заявок?
Ответ: Согласно регламенту, срок рассмотрения заявок составляет 10 рабочих дней [doc:1]. При этом комиссия вправе продлить срок на 5 дней при наличии обоснования [doc:3].

> "Заявки участников рассматриваются в течение 10 (десяти) рабочих дней с даты окончания приёма" [doc:1]

ПРИМЕР ОТКАЗА (когда информации нет):
Вопрос: Какова средняя зарплата в отделе закупок?
Ответ: В загруженных документах отсутствует информация о зарплатах сотрудников. Доступные документы содержат информацию о процедурах закупок и нормативных требованиях. Для получения данных о зарплатах рекомендую обратиться в отдел кадров.${lowConfidenceWarning}

${ragContext || "В базе знаний не найдено релевантных документов по данному запросу. Сообщи пользователю, что по его вопросу документы не найдены."}`;

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

  console.log("modelMessages count =", modelMessages.length, "systemPrompt length =", systemPrompt.length);

  // Build source filenames from filtered relevant chunks (not all 20)
  const sourceFilenames = [...new Set(relevantChunks.map((r) => r.source_filename))];

  // DEBUG: Use generateText to test if Gemini responds at all
  try {
    const { text } = await generateText({
      model: google("gemini-3-flash"),
      system: systemPrompt,
      messages: modelMessages,
      temperature: 0,
    });

    console.log("generateText SUCCESS: text length =", text.length, "preview =", text.slice(0, 300));

    if (conversationId) {
      await saveMessage(conversationId, "assistant", text);
    }

    // Return as data stream format manually
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`0:${JSON.stringify(text)}\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Sources": encodeURIComponent(JSON.stringify(sourceFilenames)),
      },
    });
  } catch (err) {
    console.error("generateText ERROR:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
