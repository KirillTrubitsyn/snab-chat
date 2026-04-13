import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { requireAdmin } from "../lib/auth.js";
import { getAdminByChatId, notifySupportReply, answerCallbackQuery, sendTelegramMessage, send2FAMessage, answer2FACallbackQuery, edit2FAMessage, notifyAllAdmins } from "../lib/telegram.js";
import { getMoscowTime } from "../lib/date-utils.js";
import { timingSafeEqual } from "crypto";

const router = Router();

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

/** Извлечь REF:uuid из текста */
function extractRef(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/REF:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return m ? m[1] : null;
}

/** Пометить обращение как "ожидающее ответ" от этого админа */
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

/** Найти обращение, ожидающее ответ от этого админа */
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

/** Сохранить ответ админа в БД */
async function saveAdminReply(supportMessageId: string, replyText: string, admin: { number: number; name: string }) {
  const supabase = createServiceClient();
  const { data: updated, error } = await supabase
    .from("support_messages")
    .update({
      admin_reply: replyText,
      admin_number: admin.number,
      status: "answered",
      replied_at: new Date().toISOString(),
      pending_admin_chat_id: null, // сбросить pending
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

/**
 * POST /api/telegram/test — проверка отправки сообщений в Telegram.
 * Доступно только админам.
 */
router.post("/api/telegram/test", async (req: Request, res: Response) => {
  try {
    const adminCheck = await requireAdmin(req, res);
    if (!adminCheck) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = [
      process.env.TELEGRAM_ADMIN_CHAT_ID_1,
      process.env.TELEGRAM_ADMIN_CHAT_ID_2,
      process.env.TELEGRAM_ADMIN_CHAT_ID_3,
      process.env.TELEGRAM_ADMIN_CHAT_ID_4,
    ];

    const chatIdInfo = chatIds.map((id, i) => ({
      name: `TELEGRAM_ADMIN_CHAT_ID_${i + 1}`,
      value: id || null,
      set: !!id,
    }));

    if (!botToken) {
      return res.status(500).json({ bot_token_set: false, chat_ids: chatIdInfo, send_results: [], error: "TELEGRAM_BOT_TOKEN не задан" });
    }

    const { getMoscowTime } = await import("../lib/date-utils.js");
    const text =
      `🧪 <b>Тест уведомлений СнабЧат</b>\n\n` +
      `✅ Бот работает, сообщения доходят\n` +
      `🕐 ${getMoscowTime()}`;

    const sendResults = await Promise.all(
      chatIds.map(async (chatId, i) => {
        if (!chatId) return { id: `_${i + 1}`, chatId: null, status: "skipped" };
        try {
          const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
          });
          const json = await tgRes.json();
          return { id: `_${i + 1}`, chatId, status: tgRes.ok ? "ok" : "error", telegram_response: json };
        } catch (e) {
          return { id: `_${i + 1}`, chatId, status: "network_error", error: String(e) };
        }
      })
    );

    return res.json({ bot_token_set: true, chat_ids: chatIdInfo, send_results: sendResults });
  } catch (err) {
    console.error("[telegram/test] Error:", err);
    return res.status(500).json({ error: "Ошибка теста" });
  }
});

/**
 * POST /api/telegram/setup — регистрация Telegram webhook(ов).
 * Регистрирует основной бот + 2FA-бот (если настроен).
 * Доступно только админам.
 */
router.post("/api/telegram/setup", async (req: Request, res: Response) => {
  try {
    const adminCheck = await requireAdmin(req, res);
    if (!adminCheck) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const bot2FAToken = process.env.TELEGRAM_2FA_BOT_TOKEN;
    const webhook2FASecret = process.env.TELEGRAM_2FA_WEBHOOK_SECRET || webhookSecret;

    if (!botToken) {
      return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN не настроен" });
    }

    // Webhook URL should point to the frontend (Vercel/Next.js), not backend
    const frontendUrl = (process.env.FRONTEND_URL || "").split(",")[0]?.trim();
    const host = frontendUrl
      ? new URL(frontendUrl).host
      : (req.headers["host"] as string) ?? "www.snabchat.app";
    const protocol = host.includes("localhost") ? "http" : "https";

    // ── Основной бот ──
    const webhookUrl = `${protocol}://${host}/api/telegram/webhook`;
    const body: Record<string, unknown> = {
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
    };
    if (webhookSecret) {
      body.secret_token = webhookSecret;
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const mainResult = await tgRes.json();

    // ── 2FA бот (если настроен) ──
    let twoFAResult = null;
    let webhook2FAUrl = "";
    if (bot2FAToken) {
      // 2FA webhook points to backend (Railway), not frontend, to share the same DB
      const backendHost = (req.headers["host"] as string) ?? host;
      const backendProtocol = backendHost.includes("localhost") ? "http" : "https";
      webhook2FAUrl = `${backendProtocol}://${backendHost}/api/telegram/webhook-2fa`;
      const body2FA: Record<string, unknown> = {
        url: webhook2FAUrl,
        allowed_updates: ["message", "callback_query"],
      };
      if (webhook2FASecret) {
        body2FA.secret_token = webhook2FASecret;
      }

      const res2FA = await fetch(`https://api.telegram.org/bot${bot2FAToken}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body2FA),
      });
      twoFAResult = await res2FA.json();
    }

    return res.json({
      main_bot: {
        webhook_url: webhookUrl,
        secret_configured: !!webhookSecret,
        telegram_response: mainResult,
      },
      two_fa_bot: bot2FAToken
        ? {
            webhook_url: webhook2FAUrl,
            secret_configured: !!webhook2FASecret,
            telegram_response: twoFAResult,
          }
        : { status: "not_configured" },
    });
  } catch (err) {
    console.error("[telegram/setup] Error:", err);
    return res.status(500).json({ error: "Ошибка настройки webhook" });
  }
});

/**
 * POST /api/telegram/test-2fa — проверка 2FA-бота.
 */
router.post("/api/telegram/test-2fa", async (req: Request, res: Response) => {
  const adminCheck = await requireAdmin(req, res);
  if (!adminCheck) return;

  const botToken = process.env.TELEGRAM_2FA_BOT_TOKEN;
  const botUsername = process.env.TELEGRAM_2FA_BOT_USERNAME || "";

  if (!botToken) {
    return res.status(500).json({ error: "TELEGRAM_2FA_BOT_TOKEN не задан в переменных окружения" });
  }

  const results: Record<string, unknown> = {
    bot_token_set: true,
    bot_username: botUsername,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TgResponse = { ok: boolean; result?: any; description?: string };

  // Проверить getMe
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = (await meRes.json()) as TgResponse;
    if (meData.ok) {
      results.bot_info = {
        id: meData.result.id,
        username: meData.result.username,
        first_name: meData.result.first_name,
      };
      results.bot_username = meData.result.username;
    } else {
      results.bot_error = meData.description || "Токен невалидный";
      return res.json(results);
    }
  } catch (e) {
    results.bot_error = `Ошибка сети: ${e}`;
    return res.json(results);
  }

  // Проверить webhook
  try {
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const whData = (await whRes.json()) as TgResponse;
    if (whData.ok) {
      results.webhook = {
        url: whData.result.url || null,
        has_custom_certificate: whData.result.has_custom_certificate,
        pending_update_count: whData.result.pending_update_count,
        last_error_date: whData.result.last_error_date || null,
        last_error_message: whData.result.last_error_message || null,
      };
    }
  } catch { /* ignore */ }

  // Отправить тестовое сообщение
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID_1;
  if (adminChatId) {
    try {
      const text =
        `🧪 <b>Тест 2FA-бота СнабЧат</b>\n\n` +
        `✅ 2FA бот @${results.bot_username} работает\n` +
        `🕐 ${getMoscowTime()}`;

      const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: adminChatId, text, parse_mode: "HTML" }),
      });
      const sendData = (await sendRes.json()) as TgResponse;
      results.test_send = {
        ok: sendData.ok,
        chat_id: adminChatId,
        error: sendData.ok ? null : sendData.description,
      };
    } catch (e) {
      results.test_send = { ok: false, chat_id: adminChatId, error: String(e) };
    }
  } else {
    results.test_send = { ok: false, error: "TELEGRAM_ADMIN_CHAT_ID_1 не задан" };
  }

  return res.json(results);
});

/**
 * POST /api/telegram/webhook — обработка входящих сообщений от бота.
 * Поддерживает:
 * 1. Callback-кнопку "Ответить" → помечает обращение pending + prompt
 * 2. Reply на сообщение с REF → сохраняет ответ
 * 3. Обычное сообщение от админа с pending → сохраняет ответ
 */
router.post("/api/telegram/webhook", async (req: Request, res: Response) => {
  try {
    // Проверка секрета (обязательна)
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

    // ── Обработка нажатия inline-кнопки "Ответить" ──
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

        // Помечаем обращение как ожидающее ответ от этого админа
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

    // ── Обработка сообщений от админа ──
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

    // Путь 1: Reply на сообщение с REF
    let supportMessageId = extractRef(message.reply_to_message?.text);

    // Путь 2: Обычное сообщение → ищем pending
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
      // Подтверждение админу
      await sendTelegramMessage(`✅ Ответ отправлен пользователю ${updated.user_name}`, chatId);
      notifySupportReply(admin.name, updated.user_name, replyText).catch(() => {});
    } else {
      await sendTelegramMessage(`⚠️ Не удалось сохранить ответ — обращение уже закрыто или не найдено.`, chatId);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[telegram/webhook] Error:", err);
    return res.json({ ok: true });
  }
});

/**
 * POST /api/telegram/webhook-2fa — вебхук 2FA-бота (@SC2FA_Bot).
 * Пользователь отправляет 6-значный OTP-код для привязки Telegram.
 */
const WEBHOOK_2FA_SECRET = process.env.TELEGRAM_2FA_WEBHOOK_SECRET || WEBHOOK_SECRET;

router.post("/api/telegram/webhook-2fa", async (req: Request, res: Response) => {
  if (!WEBHOOK_2FA_SECRET) {
    console.error("[Telegram 2FA Webhook] Secret not configured");
    return res.status(500).json({ ok: false });
  }

  const secret = (req.headers["x-telegram-bot-api-secret-token"] as string) ?? "";
  try {
    const a = Buffer.from(secret, "utf8");
    const b = Buffer.from(WEBHOOK_2FA_SECRET, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false });
    }
  } catch {
    return res.status(401).json({ ok: false });
  }

  const update = req.body;

  // ── Обработка callback_query (кнопки подтверждения входа) ──
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    const chatId = String(callbackQuery.message?.chat?.id ?? "");
    const cbData = callbackQuery.data ?? "";
    const messageId = callbackQuery.message?.message_id;

    if (cbData.startsWith("login_approve:") || cbData.startsWith("login_deny:")) {
      const approvalId = cbData.split(":")[1];
      const approved = cbData.startsWith("login_approve:");
      const supabase = createServiceClient();

      // Проверить что approval существует и принадлежит этому chat_id
      const { data: approval, error: fetchErr } = await supabase
        .from("login_approvals")
        .select("id, invite_code_id, status, ip_address, expires_at")
        .eq("id", approvalId)
        .single();

      if (fetchErr || !approval) {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос не найден");
        return res.json({ ok: true });
      }

      // Проверить что запрос принадлежит этому пользователю
      const { data: invite } = await supabase
        .from("invite_codes")
        .select("telegram_chat_id, name")
        .eq("id", approval.invite_code_id)
        .single();

      if (!invite || invite.telegram_chat_id !== chatId) {
        await answer2FACallbackQuery(callbackQuery.id, "Нет доступа");
        return res.json({ ok: true });
      }

      if (approval.status !== "pending") {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос уже обработан");
        return res.json({ ok: true });
      }

      if (new Date(approval.expires_at) < new Date()) {
        await answer2FACallbackQuery(callbackQuery.id, "Время подтверждения истекло");
        return res.json({ ok: true });
      }

      // Обновить статус (атомарно — только если ещё pending)
      const newStatus = approved ? "approved" : "denied";
      const { data: updated, error: updateErr } = await supabase
        .from("login_approvals")
        .update({ status: newStatus, resolved_at: new Date().toISOString() })
        .eq("id", approvalId)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (updateErr || !updated) {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос уже обработан");
        return res.json({ ok: true });
      }

      if (approved) {
        await answer2FACallbackQuery(callbackQuery.id, "Вход подтверждён");
        if (messageId) {
          await edit2FAMessage(
            chatId,
            messageId,
            `✅ <b>Вход подтверждён</b>\n\n` +
            `👤 ${invite.name}\n` +
            `🕐 ${getMoscowTime()}`
          );
        }
      } else {
        await answer2FACallbackQuery(callbackQuery.id, "Вход отклонён");
        if (messageId) {
          await edit2FAMessage(
            chatId,
            messageId,
            `❌ <b>Вход отклонён</b>\n\n` +
            `👤 ${invite.name}\n` +
            `🌐 ${approval.ip_address || "unknown"}\n` +
            `🕐 ${getMoscowTime()}`
          );
        }

        // Уведомить админов о подозрительной попытке входа
        const alertText =
          `🚨 <b>Подозрительная попытка входа</b>\n\n` +
          `Пользователь <b>${invite.name}</b> отклонил вход:\n` +
          `🌐 IP: ${approval.ip_address || "unknown"}\n` +
          `🕐 ${getMoscowTime()}\n\n` +
          `Возможно, кто-то пытается войти в чужой аккаунт.`;
        notifyAllAdmins(alertText).catch(() => {});
      }

      console.log(`[2FA Webhook] Login ${newStatus} for ${invite.name} (approval ${approvalId})`);
      return res.json({ ok: true });
    }

    // ── Admin login approval buttons ──
    if (cbData.startsWith("admin_login_approve:") || cbData.startsWith("admin_login_deny:")) {
      const approvalId = cbData.split(":")[1];
      const approved = cbData.startsWith("admin_login_approve:");
      const supabase = createServiceClient();

      const { data: approval, error: fetchErr } = await supabase
        .from("admin_login_approvals")
        .select("id, admin_number, status, ip_address, expires_at")
        .eq("id", approvalId)
        .single();

      if (fetchErr || !approval) {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос не найден");
        return res.json({ ok: true });
      }

      // Verify the callback is from the correct admin's chat
      const expectedChatId = process.env[`TELEGRAM_ADMIN_CHAT_ID_${approval.admin_number}`];
      if (!expectedChatId || expectedChatId !== chatId) {
        await answer2FACallbackQuery(callbackQuery.id, "Нет доступа");
        return res.json({ ok: true });
      }

      if (approval.status !== "pending") {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос уже обработан");
        return res.json({ ok: true });
      }

      if (new Date(approval.expires_at) < new Date()) {
        await answer2FACallbackQuery(callbackQuery.id, "Время подтверждения истекло");
        return res.json({ ok: true });
      }

      const newStatus = approved ? "approved" : "denied";
      const { data: updated, error: updateErr } = await supabase
        .from("admin_login_approvals")
        .update({ status: newStatus, resolved_at: new Date().toISOString() })
        .eq("id", approvalId)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (updateErr || !updated) {
        await answer2FACallbackQuery(callbackQuery.id, "Запрос уже обработан");
        return res.json({ ok: true });
      }

      const adminLabel = `Админ #${approval.admin_number}`;

      if (approved) {
        await answer2FACallbackQuery(callbackQuery.id, "Вход подтверждён");
        if (messageId) {
          await edit2FAMessage(
            chatId,
            messageId,
            `✅ <b>Вход в админ-панель подтверждён</b>\n\n` +
            `👤 ${adminLabel}\n` +
            `🕐 ${getMoscowTime()}`
          );
        }
      } else {
        await answer2FACallbackQuery(callbackQuery.id, "Вход отклонён");
        if (messageId) {
          await edit2FAMessage(
            chatId,
            messageId,
            `❌ <b>Вход в админ-панель отклонён</b>\n\n` +
            `👤 ${adminLabel}\n` +
            `🌐 ${approval.ip_address || "unknown"}\n` +
            `🕐 ${getMoscowTime()}`
          );
        }

        // Notify all admins about suspicious admin login attempt
        notifyAllAdmins(
          `🚨 <b>Подозрительная попытка входа в админ-панель</b>\n\n` +
          `${adminLabel} отклонил вход:\n` +
          `🌐 IP: ${approval.ip_address || "unknown"}\n` +
          `🕐 ${getMoscowTime()}\n\n` +
          `Возможно, кто-то пытается получить доступ к админ-панели.`
        ).catch(() => {});
      }

      console.log(`[2FA Webhook] Admin login ${newStatus} for admin #${approval.admin_number} (approval ${approvalId})`);
      return res.json({ ok: true });
    }

    await answer2FACallbackQuery(callbackQuery.id);
    return res.json({ ok: true });
  }

  const message = update?.message;
  if (!message?.text) {
    return res.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const messageText = message.text.trim();

  // /start — show instructions
  if (messageText === "/start" || messageText.startsWith("/start ")) {
    await send2FAMessage(
      "🔐 <b>СнабЧат — привязка Telegram</b>\n\n" +
      "Для привязки Telegram к аккаунту:\n" +
      "1. Откройте настройки на сайте СнабЧат\n" +
      "2. Нажмите «Включить» напротив Telegram\n" +
      "3. Скопируйте 6-значный код\n" +
      "4. Отправьте его сюда",
      chatId
    );
    return res.json({ ok: true });
  }

  // 6-digit OTP code
  const codeMatch = messageText.match(/^\d{6}$/);
  if (codeMatch) {
    const code = codeMatch[0];
    const supabase = createServiceClient();

    const { data: otpRecord, error } = await supabase
      .from("otp_codes")
      .select("id, invite_code_id, expires_at")
      .eq("code", code)
      .eq("method", "telegram")
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !otpRecord) {
      await send2FAMessage("❌ Неверный или просроченный код. Запросите новый в настройках.", chatId);
      return res.json({ ok: true });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      await send2FAMessage("❌ Код истёк. Запросите новый в настройках.", chatId);
      return res.json({ ok: true });
    }

    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ telegram_chat_id: chatId })
      .eq("id", otpRecord.invite_code_id);

    if (updateError) {
      console.error("[2FA Webhook] Link error:", updateError.message);
      await send2FAMessage("❌ Ошибка привязки. Попробуйте ещё раз.", chatId);
      return res.json({ ok: true });
    }

    await supabase.from("otp_codes").update({ used: true }).eq("id", otpRecord.id);

    await send2FAMessage(
      "✅ Telegram успешно привязан!\n\nТеперь вы будете получать коды для входа через этот чат.",
      chatId
    );
    return res.json({ ok: true });
  }

  await send2FAMessage("Отправьте 6-значный код из настроек СнабЧат.", chatId);
  return res.json({ ok: true });
});

export default router;
