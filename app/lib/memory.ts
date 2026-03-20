import { createServiceClient } from "./supabase";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

const HISTORY_TOKEN_BUDGET = 30000;
const SUMMARIZE_THRESHOLD = 25000;
const RECENT_MESSAGES_KEEP = 10;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ConversationContext {
  messages: Message[];
  hasSummary: boolean;
}

export async function loadConversationContext(
  conversationId: string
): Promise<ConversationContext> {
  const supabase = createServiceClient();

  const { data: conv } = await supabase
    .from("conversations")
    .select("summary")
    .eq("id", conversationId)
    .single();

  const { data: msgs } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const messages: Message[] = msgs ?? [];
  const hasSummary = !!conv?.summary;

  // Calculate total tokens
  let totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0
  );

  if (conv?.summary) {
    totalTokens += estimateTokens(conv.summary);
  }

  // If over threshold, summarize old messages
  if (totalTokens > SUMMARIZE_THRESHOLD && messages.length > RECENT_MESSAGES_KEEP) {
    const oldMessages = messages.slice(0, -RECENT_MESSAGES_KEEP);
    const recentMessages = messages.slice(-RECENT_MESSAGES_KEEP);

    const oldText = oldMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const contextForSummary = conv?.summary
      ? `Предыдущее резюме:\n${conv.summary}\n\nНовые сообщения:\n${oldText}`
      : oldText;

    const { text: summary } = await generateText({
      model: google("gemini-2.0-flash-lite"),
      prompt: `Кратко суммаризируй этот диалог, сохранив ключевые факты, решения и контекст. Пиши на русском, компактно (до 500 слов):\n\n${contextForSummary}`,
    });

    // Save summary and delete old messages
    await supabase
      .from("conversations")
      .update({ summary })
      .eq("id", conversationId);

    const { data: allMsgs } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (allMsgs && allMsgs.length > RECENT_MESSAGES_KEEP) {
      const idsToDelete = allMsgs
        .slice(0, -RECENT_MESSAGES_KEEP)
        .map((m) => m.id);
      await supabase.from("messages").delete().in("id", idsToDelete);
    }

    const result: Message[] = [];
    result.push({
      role: "system",
      content: `Резюме предыдущей части диалога:\n${summary}`,
    });
    result.push(...recentMessages);
    return { messages: result, hasSummary: true };
  }

  // Under threshold: return with summary prefix if exists
  const result: Message[] = [];
  if (conv?.summary) {
    result.push({
      role: "system",
      content: `Резюме предыдущей части диалога:\n${conv.summary}`,
    });
  }
  result.push(...messages);
  return { messages: result, hasSummary };
}

export async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const supabase = createServiceClient();
  const tokens = estimateTokens(content);

  await supabase.from("messages").insert({
    conversation_id: conversationId,
    role,
    content,
    token_estimate: tokens,
  });

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}
