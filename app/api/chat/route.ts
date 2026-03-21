import { NextRequest } from "next/server";
import { google } from "@/app/lib/google-ai";
import { streamText } from "ai";
import { hybridSearch } from "@/app/lib/retrieval";
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

  const ragContext = searchResults.length
    ? searchResults
        .map(
          (r, i) =>
            `[Источник ${i + 1}: ${r.source_filename}]\n${r.content}`
        )
        .join("\n\n---\n\n")
    : "";

  const systemPrompt = `Ты СнабЧат — ИИ-ассистент Дирекции по закупкам. Ты помогаешь сотрудникам с вопросами о закупках, снабжении, договорах, нормативных документах и внутренних процедурах.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА (ОБЯЗАТЕЛЬНЫ К ИСПОЛНЕНИЮ):
1. Ты ДОЛЖЕН отвечать ИСКЛЮЧИТЕЛЬНО на основе предоставленного ниже контекста из базы знаний. Это твой ЕДИНСТВЕННЫЙ источник информации.
2. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать свои общие знания, обучающие данные или делать предположения для дополнения ответа. Даже если ты "знаешь" что-то по теме — НЕ используй это.
3. Если информации в предоставленном контексте НЕДОСТАТОЧНО для полного ответа — прямо укажи: "В загруженных документах эта информация отсутствует" или "В базе знаний нет данных по этому вопросу". НЕ пытайся заполнить пробелы.
4. Если вопрос пользователя частично покрыт контекстом — ответь только на ту часть, которая покрыта, и явно укажи, какая часть вопроса не имеет ответа в документах.
5. При цитировании — приводи ДОСЛОВНЫЕ цитаты из контекста с указанием источника (имени файла). Не перефразируй и не дополняй цитаты.
6. Если контекст не содержит релевантной информации — так и скажи, не пытайся составить ответ из общих знаний.

Дополнительные правила:
- Используй деловой, но дружелюбный тон
- Форматируй ответы с использованием Markdown
- Если пользователь просит цитату — давай только дословный текст из источника

${ragContext ? `База знаний (результаты поиска):\n\n${ragContext}` : "В базе знаний не найдено релевантных документов по данному запросу. Сообщи пользователю, что по его вопросу документы не найдены."}`;

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

  const result = streamText({
    model: google("gemini-3.1-flash-lite-preview"),
    system: systemPrompt,
    messages: modelMessages,
    temperature: 0,
    async onFinish({ text }) {
      if (conversationId) {
        await saveMessage(conversationId, "assistant", text);
      }
    },
  });

  return result.toDataStreamResponse();
}
