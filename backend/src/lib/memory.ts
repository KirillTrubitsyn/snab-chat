import { createServiceClient } from "./supabase.js";
import { google, withGoogleApiLimit } from "./google-ai.js";
import { generateText } from "ai";
import { getRedis } from "./redis.js";
import { acquireLock, releaseLock } from "./summarization-lock.js";

const SUMMARIZE_THRESHOLD = 25000;
const RECENT_MESSAGES_KEEP = 10;

export function estimateTokens(text: string): number {
  // Cyrillic characters encode as ~1.5–2 tokens each in most tokenizers,
  // so text.length/2 is a more accurate estimate than /3 for Russian text.
  return Math.ceil(text.length / 2);
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

  // If over threshold, summarize old messages — but do it in background
  // so it doesn't block the current request or cause it to fail
  if (totalTokens > SUMMARIZE_THRESHOLD && messages.length > RECENT_MESSAGES_KEEP) {
    const recentMessages = messages.slice(-RECENT_MESSAGES_KEEP);

    // Fire-and-forget: summarize and clean up old messages in background
    const oldMessages = messages.slice(0, -RECENT_MESSAGES_KEEP);
    scheduleSummarization(conversationId, conv?.summary ?? null, oldMessages).catch((e) => {
      console.error("[memory] Background summarization failed (non-fatal):", e);
    });

    // Return recent messages immediately with existing summary if available
    const result: Message[] = [];
    if (conv?.summary) {
      result.push({
        role: "system",
        content: `Резюме предыдущей части диалога:\n${conv.summary}`,
      });
    }
    result.push(...recentMessages);
    return { messages: result, hasSummary };
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

/**
 * Runs summarization in background — does not block the chat request.
 * If it fails, the next request will retry.
 *
 * V25 deep-research MEDIUM-5 fix: acquire a Redis-backed per-conversation
 * advisory lock before starting. Two concurrent chat requests crossing the
 * SUMMARIZE_THRESHOLD at once previously raced on both the LLM call and the
 * subsequent message-deletion batch, occasionally losing context. With the
 * lock, only one worker runs at a time per conversation; the loser logs and
 * returns. Lock auto-expires after 120s (lock TTL >> typical run duration).
 */
async function scheduleSummarization(
  conversationId: string,
  existingSummary: string | null,
  oldMessages: Message[]
): Promise<void> {
  const redis = getRedis();
  const lockToken = await acquireLock(redis, conversationId);
  if (!lockToken) {
    console.log(
      `[memory] Skip summarization for ${conversationId} — another worker holds the lock`
    );
    return;
  }

  try {
    const supabase = createServiceClient();

    const oldText = oldMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const contextForSummary = existingSummary
      ? `Предыдущее резюме:\n${existingSummary}\n\nНовые сообщения:\n${oldText}`
      : oldText;

    const { text: summary } = await withGoogleApiLimit(() => generateText({
      model: google("gemini-3.1-flash-lite-preview"),
      prompt: `Кратко суммаризируй этот диалог, сохранив ключевые факты, решения и контекст. Пиши на русском, компактно (до 500 слов):\n\n${contextForSummary}`,
    }));

    // Save summary
    await supabase
      .from("conversations")
      .update({ summary })
      .eq("id", conversationId);

    // Delete old messages
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

    console.log(
      `[memory] Background summarization complete for conversation ${conversationId}`
    );
  } finally {
    await releaseLock(redis, conversationId, lockToken);
  }
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

  // Supabase-js returns `{ error }` instead of throwing on DB errors; without
  // this check a failed insert is silently ignored and we end up with orphan
  // assistant replies and missing user questions in history.
  const { error: insertError } = await supabase.from("messages").insert(row);
  if (insertError) {
    throw new Error(
      `saveMessage insert failed (role=${role}, conv=${conversationId}): ${insertError.message}`
    );
  }

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}
