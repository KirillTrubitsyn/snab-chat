import { Router, Request, Response } from "express";
import {
  validateInviteCode,
} from "../../lib/auth.js";
import {
  sendOtpSchema,
  verifyOtpSchema,
  telegramLinkSchema,
  setupSmsSchema,
  verifySetupOtpSchema,
  twoFactorMethodSchema,
  requestLoginApprovalSchema,
  parseBody,
} from "../../lib/validation.js";
import { createServiceClient } from "../../lib/supabase.js";
import { send2FAMessage } from "../../lib/telegram.js";
import { getMoscowTime } from "../../lib/date-utils.js";
import {
  generateOTP,
  saveOTP,
  verifyOTP,
  checkOTPRateLimit,
  generateTOTPSecret,
  generateTOTPUrl,
  verifyTOTP,
} from "../../lib/otp.js";
import { sendSMS } from "../../lib/sms.js";
import { logSecurityEvent } from "../../lib/security-log.js";
import { getClientIP, escapeHtml } from "./helpers.js";

const router = Router();

const BOT_USERNAME = process.env.TELEGRAM_2FA_BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || "";

// POST /api/auth/send-otp
router.post("/api/auth/send-otp", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, sendOtpSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("telegram_chat_id, phone_number")
      .eq("id", invite.id)
      .single();

    if (!codeData) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const withinLimit = await checkOTPRateLimit(invite.id, `login_${parsed.data.method}`);
    if (!withinLimit) {
      return res.status(429).json({ error: "Слишком много попыток. Подождите немного." });
    }

    const otp = generateOTP();
    const dbMethod = `login_${parsed.data.method}`;

    if (parsed.data.method === "telegram") {
      if (!codeData.telegram_chat_id) {
        return res.status(400).json({ error: "Telegram не привязан" });
      }
      await saveOTP(invite.id, otp, dbMethod);
      const sent = await send2FAMessage(
        `🔐 Ваш код для входа в СнабЧат: <b>${otp}</b>\n\nКод действителен 5 минут.`,
        codeData.telegram_chat_id
      );
      if (!sent) {
        return res.status(500).json({ error: "Ошибка отправки в Telegram" });
      }
    } else if (parsed.data.method === "sms") {
      if (!codeData.phone_number) {
        return res.status(400).json({ error: "Номер телефона не привязан" });
      }
      await saveOTP(invite.id, otp, dbMethod);
      const smsResult = await sendSMS(
        codeData.phone_number,
        `СнабЧат: ваш код для входа ${otp}. Действителен 5 минут.`
      );
      if (!smsResult.ok) {
        return res.status(500).json({ error: smsResult.error || "Ошибка отправки SMS" });
      }
    }

    return res.json({ sent: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/verify-otp
router.post("/api/auth/verify-otp", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, verifyOtpSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    let valid = false;

    if (parsed.data.method === "totp") {
      const supabase = createServiceClient();
      const { data: codeData } = await supabase
        .from("invite_codes")
        .select("totp_secret")
        .eq("id", invite.id)
        .single();

      if (!codeData?.totp_secret) {
        return res.status(400).json({ error: "TOTP не настроен" });
      }

      valid = verifyTOTP(parsed.data.otp, codeData.totp_secret);
    } else {
      const dbMethod = `login_${parsed.data.method}`;
      valid = await verifyOTP(invite.id, parsed.data.otp, dbMethod);
    }

    if (!valid) {
      logSecurityEvent("auth.otp_fail", {
        ip: getClientIP(req),
        userAgent: req.headers["user-agent"] as string,
        inviteCodeId: invite.id,
        details: { method: parsed.data.method, endpoint: "/api/auth/verify-otp" },
      });
      return res.status(401).json({ error: "Неверный код" });
    }

    return res.json({
      success: true,
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/telegram-link — генерация OTP для привязки Telegram
router.post("/api/auth/telegram-link", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, telegramLinkSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    if (!BOT_USERNAME) {
      return res.status(500).json({ error: "TELEGRAM_BOT_USERNAME не настроен" });
    }

    const otp = generateOTP();
    try {
      await saveOTP(invite.id, otp, "telegram", 10);
    } catch (err) {
      console.error("[telegram-link] saveOTP failed:", err);
      return res.status(500).json({ error: "Ошибка сохранения кода. Проверьте таблицу otp_codes в Supabase." });
    }

    const botUrl = `https://t.me/${BOT_USERNAME}`;

    return res.json({ otp, botUrl });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/setup-sms
router.post("/api/auth/setup-sms", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, setupSmsSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const withinLimit = await checkOTPRateLimit(invite.id, "sms");
    if (!withinLimit) {
      return res.status(429).json({ error: "Слишком много попыток. Подождите немного." });
    }

    const otp = generateOTP();
    await saveOTP(invite.id, otp, "sms");

    const smsResult = await sendSMS(
      parsed.data.phone,
      `СнабЧат: ваш код подтверждения ${otp}. Действителен 5 минут.`
    );

    if (!smsResult.ok) {
      return res.status(500).json({ error: smsResult.error || "Ошибка отправки SMS" });
    }

    return res.json({ sent: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// GET /api/auth/setup-totp
router.get("/api/auth/setup-totp", async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string | undefined;
    if (!code) {
      return res.status(400).json({ error: "Код не указан" });
    }

    const upperCode = code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const secret = generateTOTPSecret();
    const otpauthUrl = generateTOTPUrl(secret, invite.name);

    return res.json({ secret, otpauthUrl });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/verify-setup-otp
router.post("/api/auth/verify-setup-otp", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, verifySetupOtpSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();

    if (parsed.data.method === "totp") {
      if (!parsed.data.totpSecret) {
        return res.status(400).json({ error: "TOTP-секрет не указан" });
      }

      const valid = verifyTOTP(parsed.data.otp, parsed.data.totpSecret);
      if (!valid) {
        return res.status(401).json({ error: "Неверный код" });
      }

      const { error: updateError } = await supabase
        .from("invite_codes")
        .update({ totp_secret: parsed.data.totpSecret })
        .eq("id", invite.id);

      if (updateError) {
        return res.status(500).json({ error: "Ошибка сохранения" });
      }
    } else if (parsed.data.method === "sms") {
      if (!parsed.data.phone) {
        return res.status(400).json({ error: "Номер телефона не указан" });
      }

      const valid = await verifyOTP(invite.id, parsed.data.otp, "sms");
      if (!valid) {
        return res.status(401).json({ error: "Неверный код" });
      }

      const { error: updateError } = await supabase
        .from("invite_codes")
        .update({ phone_number: parsed.data.phone })
        .eq("id", invite.id);

      if (updateError) {
        return res.status(500).json({ error: "Ошибка сохранения" });
      }
    } else if (parsed.data.method === "telegram") {
      const valid = await verifyOTP(invite.id, parsed.data.otp, "telegram");
      if (!valid) {
        return res.status(401).json({ error: "Неверный код" });
      }
    }

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// DELETE /api/auth/2fa-method
router.delete("/api/auth/2fa-method", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, twoFactorMethodSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();
    const fieldMap: Record<string, string> = {
      telegram: "telegram_chat_id",
      sms: "phone_number",
      totp: "totp_secret",
    };

    const field = fieldMap[parsed.data.method];
    if (!field) {
      return res.status(400).json({ error: "Неизвестный метод" });
    }

    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ [field]: null })
      .eq("id", invite.id);

    if (updateError) {
      console.error("[2fa-method] DB error:", updateError.message);
      return res.status(500).json({ error: "Ошибка удаления" });
    }

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// GET /api/auth/2fa-status
router.get("/api/auth/2fa-status", async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string | undefined;
    if (!code) {
      return res.status(400).json({ error: "Код не указан" });
    }

    const upperCode = code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("telegram_chat_id, phone_number, totp_secret")
      .eq("id", invite.id)
      .single();

    return res.json({
      telegram: !!codeData?.telegram_chat_id,
      sms: !!codeData?.phone_number,
      totp: !!codeData?.totp_secret,
      phone: codeData?.phone_number
        ? codeData.phone_number.replace(/^(\+7)\d{7}(\d{3})$/, "$1***$2")
        : null,
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ── Push-уведомления при входе через Telegram ──

// POST /api/auth/request-login-approval
router.post("/api/auth/request-login-approval", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, requestLoginApprovalSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("telegram_chat_id")
      .eq("id", invite.id)
      .single();

    if (!codeData?.telegram_chat_id) {
      return res.status(400).json({ error: "Telegram не привязан" });
    }

    // Истечь старые pending approvals
    await supabase
      .from("login_approvals")
      .update({ status: "denied", resolved_at: new Date().toISOString() })
      .eq("invite_code_id", invite.id)
      .eq("status", "pending");

    const ipAddress = getClientIP(req);
    const userAgent = req.headers["user-agent"] || "";

    // Определить геолокацию по IP
    let location = "";
    if (ipAddress && ipAddress !== "unknown") {
      try {
        const geoRes = await fetch(`https://ipapi.co/${ipAddress}/json/`, {
          headers: { "User-Agent": "snabchat/1.0" },
          signal: AbortSignal.timeout(3000),
        });
        if (geoRes.ok) {
          const geo = await geoRes.json() as { city?: string; country_name?: string; error?: boolean };
          if (!geo.error && (geo.city || geo.country_name)) {
            location = [geo.city, geo.country_name].filter(Boolean).join(", ");
          }
        }
      } catch (e) {
        console.log(`[geo] Failed for ${ipAddress}:`, e instanceof Error ? e.message : e);
      }
    }

    // Создать новый запрос на подтверждение
    const { data: approval, error: insertError } = await supabase
      .from("login_approvals")
      .insert({
        invite_code_id: invite.id,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .select("id")
      .single();

    if (insertError || !approval) {
      console.error("[request-login-approval] DB error:", insertError?.message);
      return res.status(500).json({ error: "Ошибка создания запроса" });
    }

    // Отправить уведомление в Telegram
    const locationLine = location ? `\n📍 ${escapeHtml(location)}` : "";
    const text =
      `🔐 <b>Вход в СнабЧат</b>\n\n` +
      `Кто-то входит в ваш аккаунт:\n` +
      `👤 <b>${escapeHtml(invite.name)}</b>\n` +
      `🌐 ${escapeHtml(ipAddress)}${locationLine}\n` +
      `🕐 ${getMoscowTime()}\n\n` +
      `Это вы?`;

    const replyMarkup = {
      inline_keyboard: [[
        { text: "✅ Да, это я", callback_data: `login_approve:${approval.id}` },
        { text: "❌ Нет, не я", callback_data: `login_deny:${approval.id}` },
      ]],
    };

    const sent = await send2FAMessage(text, codeData.telegram_chat_id, replyMarkup);
    if (!sent) {
      return res.status(500).json({ error: "Ошибка отправки уведомления в Telegram" });
    }

    return res.json({ approval_id: approval.id });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// GET /api/auth/check-login-approval
router.get("/api/auth/check-login-approval", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string | undefined;
    if (!id) {
      return res.status(400).json({ error: "ID не указан" });
    }

    const supabase = createServiceClient();
    const { data: approval, error } = await supabase
      .from("login_approvals")
      .select("id, invite_code_id, status, expires_at")
      .eq("id", id)
      .single();

    if (error || !approval) {
      return res.status(404).json({ error: "Запрос не найден" });
    }

    // Проверить таймаут
    if (approval.status === "pending" && new Date(approval.expires_at) < new Date()) {
      return res.json({ status: "expired" });
    }

    if (approval.status === "approved") {
      // Вернуть данные пользователя для завершения входа
      const { data: invite } = await supabase
        .from("invite_codes")
        .select("id, code, name")
        .eq("id", approval.invite_code_id)
        .single();

      return res.json({
        status: "approved",
        inviteCodeId: invite?.id,
        name: invite?.name,
        code: invite?.code,
      });
    }

    return res.json({ status: approval.status });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

export default router;
