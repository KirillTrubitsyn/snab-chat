import { NextRequest } from "next/server";
import { google } from "@ai-sdk/google";
import { streamText } from "ai";
import { hybridSearch } from "@/app/lib/retrieval";
import { loadConversationContext, saveMessage } from "@/app/lib/memory";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { messages, conversationId } = await req.json();

  const userMessage = messages[messages.length - 1];

  // Save user message
  if (conversationId) {
    await saveMessage(conversationId, "user", userMessage.content);
  }

  // Load conversation context
  let contextMessages: { role: string; content: string }[] = [];
  if (conversationId) {
    const ctx = await loadConversationContext(conversationId);
    contextMessages = ctx.messages;
  }

  // RAG search
  const searchResults = await hybridSearch(userMessage.content, 5);

  const ragContext = searchResults.length
    ? searchResults
        .map(
          (r, i) =>
            `[Источник ${i + 1}: ${r.source_filename}]\n${r.content}`
        )
        .join("\n\n---\n\n")
    : "";

  const systemPrompt = `Ты СнабЧат — ИИ-ассистент Дирекции по закупкам. Ты помогаешь сотрудникам с вопросами о закупках, снабжении, договорах, нормативных документах и внутренних процедурах.

Правила:
- Отвечай точно и по существу, опираясь на предоставленный контекст из базы знаний
- Если в контексте нет информации для ответа, честно скажи об этом
- Используй деловой, но дружелюбный тон
- Форматируй ответы с использованием Markdown
- Если цитируешь документ, указывай источник

${ragContext ? `База знаний (результаты поиска):\n\n${ragContext}` : "В базе знаний не найдено релевантных документов."}`;

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
    model: google("gemini-2.0-flash-lite"),
    system: systemPrompt,
    messages: modelMessages,
    async onFinish({ text }) {
      if (conversationId) {
        await saveMessage(conversationId, "assistant", text);
      }
    },
  });

  return result.toDataStreamResponse();
}
