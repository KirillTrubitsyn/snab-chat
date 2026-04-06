import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { requireAdmin } from "../lib/auth.js";
import { getAdminByChatId, notifySupportReply, answerCallbackQuery, sendTelegramMessage } from "../lib/telegram.js";
import { timingSafeEqual } from "crypto";

const router = Router();

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

function extractRef(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/REF:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return m ? m[1] : null;
}

async function setPendingReply(supportMessageId: string, adminChatId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("support_messages")
    .update({ pending_admin_chat_id: adminChatId })
    .eq("id", supportMessageId)
    .eq("status", "open");
  if (error) {
    console.error(`[Telegram Webhook] setPendingReply error:`, error.message);
    return false;
  }
  return true;
}

async function findPendingReply(adminChatId: string): Promise<string | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("support_messages")
    .select("id")
    .eq("pending_admin_chat_id", adminChatId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[Telegram Webhook] findPendingReply error:`, error.message);
    return null;
  }
  return data?.id ?? null;
}

async function saveAdminReply(supportMessageId: string, replyText: string, admin: { number: number; name: string }) {
  const supabase = createServiceClient();
  const { data: updated, error } = await supabase
    .from("support_messages")
    .update({
      admin_reply: replyText,
      admin_number: admin.number,
      status: "answered",
      replied_at: new Date().toISOString(),
      pending_admin_chat_id: null,
    })
    .eq("id", supportMessageId)
    .eq("status", "open")
    .select("user_name")
    .single();

  if (error) {
    console.error(`[Telegram Webhook] DB update error:`, error.message);
    return null;
  }
  return updated;
}

router.post("/api/telegram/setup", async (req: Request, res: Response) => {
  const adminCheck = requireAdmin(req, res);
  if (!adminCheck) return;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!botToken) {
    return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN не настроен" });
  }

  const host = (req.headers["host"] as string) ?? "www.snabchat.app";
  const protocol = host.includes("localhost") ? "http" : "https";
  const webhookUrl = `${protocol}://${host}/api/telegram/webhook`;

  const body: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ["message"],
  };
  if (webhookSecret) {
    body.secret_token = webhookSecret;
  }

  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await tgRes.json();

  return res.json({
    webhook_url: webhookUrl,
    secret_configured: !!webhookSecret,
    telegram_response: result,
  });
});

router.post("/api/telegram/webhook", async (req: Request, res: Response) => {
  if (!WEBHOOK_SECRET) {
    console.error("[Telegram Webhook] TELEGRAM_WEBHOOK_SECRET is not configured");
    return res.status(500).json({ ok: false });
  }

  const secret = (req.headers["x-telegram-bot-api-secret-token"] as string) ?? "";
  try {
    const a = Buffer.from(secret, "utf8");
    const b = Buffer.from(WEBHOOK_SECRET, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false });
    }
  } catch {
    return res.status(401).json({ ok: false });
  }

  const update = req.body;
  if (!update) {
    return res.json({ ok: true });
  }

  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    const chatId = String(callbackQuery.message?.chat?.id ?? "");
    const admin = getAdminByChatId(chatId);
    if (!admin) {
      await answerCallbackQuery(callbackQuery.id, "Нет доступа");
      return res.json({ ok: true });
    }

    const data = callbackQuery.data ?? "";
    if (data.startsWith("reply:")) {
      const supportId = data.slice(6);
      const ok = await setPendingReply(supportId, chatId);
      if (ok) {
        await answerCallbackQuery(callbackQuery.id, "Напишите ответ в следующем сообщении ✍️");
        await sendTelegramMessage(
          `✍️ Напишите ответ — следующее ваше сообщение будет отправлено пользователю.\n\n<i>Или ответьте Reply ↩️ на уведомление выше.</i>`,
          chatId
        );
        console.log(`[Telegram Webhook] Pending reply set: admin ${admin.name}, support ${supportId}`);
      } else {
        await answerCallbackQuery(callbackQuery.id, "Обращение уже закрыто или не найдено");
      }
    } else {
      await answerCallbackQuery(callbackQuery.id);
    }
    return res.json({ ok: true });
  }

  const message = update?.message;
  if (!message?.text) {
    return res.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const admin = getAdminByChatId(chatId);
  if (!admin) {
    return res.json({ ok: true });
  }

  const replyText = message.text.trim().slice(0, 5000);
  if (!replyText) {
    return res.json({ ok: true });
  }

  let supportMessageId = extractRef(message.reply_to_message?.text);

  if (!supportMessageId) {
    supportMessageId = await findPendingReply(chatId);
    if (supportMessageId) {
      console.log(`[Telegram Webhook] Matched pending reply for admin ${admin.name}`);
    }
  }

  if (!supportMessageId) {
    return res.json({ ok: true });
  }

  console.log(`[Telegram Webhook] Admin ${admin.name} replying to support ${supportMessageId}`);

  const updated = await saveAdminReply(supportMessageId, replyText, admin);
  if (updated) {
    console.log(`[Telegram Webhook] Reply saved for user: ${updated.user_name}`);
    await sendTelegramMessage(`✅ Ответ отправлен пользователю ${updated.user_name}`, chatId);
    notifySupportReply(admin.name, updated.user_name, replyText).catch(() => {});
  } else {
    await sendTelegramMessage(`⚠️ Не удалось сохранить ответ — обращение уже закрыто или не найдено.`, chatId);
  }

  return res.json({ ok: true });
});

export default router;
