import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import {
  isAdminCode,
  getAdminName,
  getAdminNumber,
  isDocumentAdmin,
  isCodeDeletionAdmin,
  validateInviteCode,
  consumeInviteCodeFallback,
  checkAndRegisterDevice,
} from "../lib/auth.js";
import {
  loginSchema,
  setPasswordSchema,
  verifyPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
  telegramLinkSchema,
  setupSmsSchema,
  verifySetupOtpSchema,
  changePasswordSchema,
  twoFactorMethodSchema,
  parseBody,
} from "../lib/validation.js";
import { createServiceClient } from "../lib/supabase.js";
import { notifyNewUser, send2FAMessage } from "../lib/telegram.js";
import {
  generateOTP,
  saveOTP,
  verifyOTP,
  checkOTPRateLimit,
  generateTOTPSecret,
  generateTOTPUrl,
  verifyTOTP,
} from "../lib/otp.js";
import { sendSMS } from "../lib/sms.js";

const router = Router();

const BOT_USERNAME = process.env.TELEGRAM_2FA_BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || "";

// POST /api/auth/login
router.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, loginSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const device_id = parsed.data.device_id;

    // 1. Проверка админ-кодов
    if (isAdminCode(upperCode)) {
      const adminName = getAdminName(upperCode)!;
      return res.json({
        type: "admin",
        adminName,
        code: upperCode,
        isDocumentAdmin: isDocumentAdmin(upperCode),
        isPrimaryAdmin: getAdminNumber(upperCode) === 1,
        canDeleteCodes: isCodeDeletionAdmin(upperCode),
      });
    }

    // 2. Проверка инвайт-кодов в БД
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({
        error: "Неверный или деактивированный инвайт-код",
      });
    }

    // 3. Получить данные о 2FA и пароле
    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash, telegram_chat_id, phone_number, totp_secret")
      .eq("id", invite.id)
      .single();

    const hasPassword = !!codeData?.password_hash;
    const twoFactorMethods: string[] = [];
    if (codeData?.telegram_chat_id) twoFactorMethods.push("telegram");
    if (codeData?.phone_number) twoFactorMethods.push("sms");
    if (codeData?.totp_secret) twoFactorMethods.push("totp");

    // 4. Проверка лимита устройств
    let isNewDevice = false;
    if (device_id) {
      const userAgent = req.headers["user-agent"] || "";
      const { error: deviceError, isNewDevice: newDevice } = await checkAndRegisterDevice(
        invite.id,
        device_id,
        invite.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return res.status(403).json({ error: deviceError });
      }
      isNewDevice = newDevice;
    }

    // 5. Уменьшаем счётчик только для пользователей БЕЗ пароля (первый вход)
    if (!hasPassword) {
      await consumeInviteCodeFallback(invite.id);
    }

    // 6. Уведомление при активации кода с нового устройства
    if (isNewDevice) {
      notifyNewUser(invite.name, invite.organization).catch(() => {});
    }

    return res.json({
      type: "user",
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      hasPassword,
      twoFactorMethods,
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/register
router.post("/api/auth/register", async (_req: Request, res: Response) => {
  try {
    return res.status(403).json({
      error:
        "Регистрация временно приостановлена. Обратитесь к администратору для получения кода доступа.",
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/set-password
router.post("/api/auth/set-password", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, setPasswordSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash")
      .eq("id", invite.id)
      .single();

    if (codeData?.password_hash) {
      return res.status(400).json({ error: "Пароль уже установлен" });
    }

    const hash = await bcrypt.hash(parsed.data.password, 12);
    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ password_hash: hash })
      .eq("id", invite.id);

    if (updateError) {
      console.error("[set-password] DB error:", updateError.message);
      return res.status(500).json({ error: "Ошибка сохранения" });
    }

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/verify-password
router.post("/api/auth/verify-password", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, verifyPasswordSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash, telegram_chat_id, phone_number, totp_secret")
      .eq("id", invite.id)
      .single();

    if (!codeData?.password_hash) {
      return res.status(400).json({ error: "Пароль не установлен" });
    }

    const valid = await bcrypt.compare(parsed.data.password, codeData.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Неверный пароль" });
    }

    // Проверка лимита устройств
    let isNewDevice = false;
    if (parsed.data.device_id) {
      const userAgent = req.headers["user-agent"] || "";
      const { error: deviceError, isNewDevice: newDevice } = await checkAndRegisterDevice(
        invite.id,
        parsed.data.device_id,
        invite.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return res.status(403).json({ error: deviceError });
      }
      isNewDevice = newDevice;
    }

    if (isNewDevice) {
      notifyNewUser(invite.name, invite.organization).catch(() => {});
    }

    const twoFactorMethods: string[] = [];
    if (codeData.telegram_chat_id) twoFactorMethods.push("telegram");
    if (codeData.phone_number) twoFactorMethods.push("sms");
    if (codeData.totp_secret) twoFactorMethods.push("totp");

    return res.json({
      success: true,
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      twoFactorMethods,
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

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
      const sent = await sendSMS(
        codeData.phone_number,
        `СнабЧат: ваш код для входа ${otp}. Действителен 5 минут.`
      );
      if (!sent) {
        return res.status(500).json({ error: "Ошибка отправки SMS" });
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

// POST /api/auth/telegram-link
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

    const supabase = createServiceClient();

    // Инвалидировать старые неиспользованные токены
    await supabase
      .from("telegram_link_tokens")
      .update({ used: true })
      .eq("invite_code_id", invite.id)
      .eq("used", false);

    // Создать новый токен (10 минут)
    const token = randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from("telegram_link_tokens")
      .insert({
        invite_code_id: invite.id,
        token,
        expires_at: expiresAt,
      });

    if (insertError) {
      console.error("[telegram-link] DB error:", insertError.message);
      return res.status(500).json({ error: "Ошибка создания токена" });
    }

    const botUrl = `https://t.me/${BOT_USERNAME}?start=${token}`;

    return res.json({ token, botUrl });
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

    const sent = await sendSMS(
      parsed.data.phone,
      `СнабЧат: ваш код подтверждения ${otp}. Действителен 5 минут.`
    );

    if (!sent) {
      return res.status(500).json({ error: "Ошибка отправки SMS" });
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

// POST /api/auth/change-password
router.post("/api/auth/change-password", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, changePasswordSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash")
      .eq("id", invite.id)
      .single();

    if (!codeData?.password_hash) {
      return res.status(400).json({ error: "Пароль не установлен" });
    }

    const valid = await bcrypt.compare(parsed.data.oldPassword, codeData.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Неверный текущий пароль" });
    }

    const hash = await bcrypt.hash(parsed.data.newPassword, 12);
    const { error: updateError } = await supabase
      .from("invite_codes")
      .update({ password_hash: hash })
      .eq("id", invite.id);

    if (updateError) {
      return res.status(500).json({ error: "Ошибка сохранения" });
    }

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

export default router;
