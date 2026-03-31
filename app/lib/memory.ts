import { createServiceClient } from "./supabase";
import { google, withGoogleApiLimit } from "@/app/lib/google-ai";
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

  // Load conversation and messages in parallel; limit messages to avoid loading huge histories
  const MAX_MESSAGES_LOAD = 50;

  const [{ data: conv }, { data: msgs }] = await Promise.all([
    supabase
      .from("conversations")
      .select("summary")
      .eq("id", conversationId)
      .single(),
    supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(MAX_MESSAGES_LOAD)
      .then((res) => ({
        ...res,
        data: res.data?.reverse() ?? null,
      })),
  ]);

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

    const { text: summary } = await withGoogleApiLimit(() => generateText({
      model: google("gemini-3.1-flash-lite-preview"),
      prompt: `Кратко суммаризируй этот диалог, сохранив ключевые факты, решения и контекст. Пиши на русском, компактно (до 500 слов):\n\n${contextForSummary}`,
    }));

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
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const supabase = createServiceClient();
  const tokens = estimateTokens(content);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: Record<string, any> = {
    conversation_id: conversationId,
    role,
    content,
    token_estimate: tokens,
  };
  if (metadata) row.metadata = metadata;

  await supabase.from("messages").insert(row);

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}
