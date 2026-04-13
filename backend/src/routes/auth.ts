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
  checkAndRegisterDevice,
  generateAuthToken,
  getInviteCodeFromHeader,
  getAdmin2FAStatus,
  getAdmin2FAData,
  generateAdminSessionToken,
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
  requestLoginApprovalSchema,
  adminSetupTotpSchema,
  adminVerifySetupTotpSchema,
  adminSetupTelegramSchema,
  adminVerifySetupTelegramSchema,
  adminVerify2FASchema,
  adminSendOtpSchema,
  adminRequestLoginApprovalSchema,
  parseBody,
} from "../lib/validation.js";
import { createServiceClient } from "../lib/supabase.js";
import { notifyNewUser, send2FAMessage } from "../lib/telegram.js";
import {
  saveAdminOTP,
  verifyAdminOTP,
  checkAdminOTPRateLimit,
} from "../lib/admin-otp.js";
import { getMoscowTime } from "../lib/date-utils.js";
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
import { logSecurityEvent } from "../lib/security-log.js";
import { checkRateLimit } from "../middleware/rate-limit.js";

const router = Router();

const BOT_USERNAME = process.env.TELEGRAM_2FA_BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || "";

// POST /api/auth/login
router.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const clientIp = getClientIP(req);

    // Rate limit login attempts to prevent brute force on admin/invite codes
    const loginRL = await checkRateLimit(`login:${clientIp}`, 10, 60_000);
    if (loginRL) {
      return res.status(429).json({ error: "Слишком много попыток входа. Подождите минуту." });
    }

    const parsed = parseBody(req.body, loginSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const device_id = parsed.data.device_id;

    // 1. Проверка админ-кодов
    if (isAdminCode(upperCode)) {
      const adminName = getAdminName(upperCode)!;
      const adminNumber = getAdminNumber(upperCode)!;
      const admin2fa = await getAdmin2FAStatus(adminNumber);
      return res.json({
        type: "admin",
        adminName,
        adminNumber,
        needs2FASetup: !admin2fa.hasAnyMethod,
        twoFactorMethods: admin2fa.methods,
        code: upperCode,
        isDocumentAdmin: isDocumentAdmin(upperCode),
        isPrimaryAdmin: adminNumber === 1,
        canDeleteCodes: isCodeDeletionAdmin(upperCode),
      });
    }

    // 2. Проверка инвайт-кодов в БД
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      logSecurityEvent("auth.invite_code_fail", {
        ip: getClientIP(req),
        userAgent: req.headers["user-agent"] as string,
        details: { endpoint: "/api/auth/login" },
      });
      return res.status(401).json({
        error: "Неверный или деактивированный инвайт-код",
      });
    }

    // 3. Получить данные о 2FA и пароле
    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("password_hash, telegram_chat_id, phone_number, totp_secret, video_seen")
      .eq("id", invite.id)
      .single();

    const hasPassword = !!codeData?.password_hash;
    const videoSeen = !!codeData?.video_seen;
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

    // 5. НЕ расходуем uses_remaining здесь — это делает set-password после установки пароля.
    // Если расходовать на этапе login, то set-password и 2FA-роуты не смогут пройти валидацию.

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
      videoSeen,
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

// R5 fix: distributed rate limiter for password operations (10 req/min per IP)
// Uses Redis when available, falls back to in-memory
async function checkPasswordOpsRate(ip: string): Promise<boolean> {
  const result = await checkRateLimit(`pwd:${ip}`, 10, 60_000);
  return result === null;
}

// POST /api/auth/set-password
router.post("/api/auth/set-password", async (req: Request, res: Response) => {
  try {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",").pop()?.trim() || req.ip || "unknown";
    if (!(await checkPasswordOpsRate(clientIp))) {
      return res.status(429).json({ error: "Слишком много запросов" });
    }
    const parsed = parseBody(req.body, setPasswordSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.code.toUpperCase();
    const supabase = createServiceClient();

    // Ищем код напрямую, БЕЗ validateInviteCode —
    // uses_remaining уже 0 после login, это нормально
    const { data: invite, error: dbError } = await supabase
      .from("invite_codes")
      .select("id, password_hash, is_active")
      .eq("code", upperCode)
      .single();

    if (dbError || !invite) {
      return res.status(401).json({ error: "Неверный инвайт-код" });
    }

    if (!invite.is_active) {
      return res.status(401).json({ error: "Этот инвайт-код деактивирован" });
    }

    if (invite.password_hash) {
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

    // Generate auth token immediately after password creation
    const authToken = generateAuthToken(invite.id);

    return res.json({ success: true, authToken });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/verify-password
router.post("/api/auth/verify-password", async (req: Request, res: Response) => {
  try {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",").pop()?.trim() || req.ip || "unknown";
    if (!(await checkPasswordOpsRate(clientIp))) {
      return res.status(429).json({ error: "Слишком много запросов" });
    }
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
      .select("password_hash, telegram_chat_id, phone_number, totp_secret, video_seen")
      .eq("id", invite.id)
      .single();

    if (!codeData?.password_hash) {
      return res.status(400).json({ error: "Пароль не установлен" });
    }

    const valid = await bcrypt.compare(parsed.data.password, codeData.password_hash);
    if (!valid) {
      logSecurityEvent("auth.password_fail", {
        ip: getClientIP(req),
        userAgent: req.headers["user-agent"] as string,
        inviteCodeId: invite.id,
        details: { endpoint: "/api/auth/verify-password" },
      });
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

    const authToken = generateAuthToken(invite.id);

    return res.json({
      success: true,
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      twoFactorMethods,
      authToken,
      videoSeen: !!codeData.video_seen,
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
    // Rate limit OTP verification attempts before any DB operations
    const clientIp = getClientIP(req);
    const otpVerifyRL = await checkRateLimit(`otp-verify:${clientIp}`, 10, 60_000);
    if (otpVerifyRL) {
      return res.status(429).json({ error: "Слишком много попыток. Подождите минуту." });
    }

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

    const authToken = generateAuthToken(invite.id);

    return res.json({
      success: true,
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
      authToken,
      videoSeen: !!invite.video_seen,
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

// POST /api/auth/change-password
router.post("/api/auth/change-password", async (req: Request, res: Response) => {
  try {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",").pop()?.trim() || req.ip || "unknown";
    if (!(await checkPasswordOpsRate(clientIp))) {
      return res.status(429).json({ error: "Слишком много запросов" });
    }
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

// ── Push-уведомления при входе через Telegram ──

function getClientIP(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    // Take the LAST IP — it's the one added by our trusted reverse proxy.
    // The first IP can be spoofed by the client via header injection.
    const ips = forwarded.split(",").map(s => s.trim()).filter(Boolean);
    return ips[ips.length - 1] || "unknown";
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string") return realIp;
  return req.ip || "unknown";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

// N2 fix: strict per-IP rate limit for approval polling (5 req/min)
const approvalPollLimiter = new Map<string, number[]>();
function checkApprovalRateLimit(ip: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const maxReqs = 5;
  const timestamps = (approvalPollLimiter.get(ip) || []).filter(t => now - t < window);
  if (timestamps.length >= maxReqs) return false;
  timestamps.push(now);
  approvalPollLimiter.set(ip, timestamps);
  return true;
}
// Cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of approvalPollLimiter) {
    const fresh = ts.filter(t => now - t < 60_000);
    if (fresh.length === 0) approvalPollLimiter.delete(ip);
    else approvalPollLimiter.set(ip, fresh);
  }
}, 300_000);

// GET /api/auth/check-login-approval
router.get("/api/auth/check-login-approval", async (req: Request, res: Response) => {
  try {
    // N2 fix: rate limit polling to prevent enumeration
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",").pop()?.trim() || req.ip || "unknown";
    if (!checkApprovalRateLimit(clientIp)) {
      return res.status(429).json({ error: "Слишком много запросов" });
    }

    const id = req.query.id as string | undefined;
    if (!id) {
      return res.status(400).json({ error: "ID не указан" });
    }

    // N2 fix: validate UUID format to prevent probing
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: "Неверный формат ID" });
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
        .select("id, code, name, video_seen")
        .eq("id", approval.invite_code_id)
        .single();

      const authToken = invite ? generateAuthToken(invite.id) : undefined;

      return res.json({
        status: "approved",
        inviteCodeId: invite?.id,
        name: invite?.name,
        code: invite?.code,
        authToken,
        videoSeen: !!invite?.video_seen,
      });
    }

    return res.json({ status: approval.status });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// N3 fix: strict per-IP rate limit for password login (5 req/min)
const passwordLoginLimiter = new Map<string, number[]>();
function checkPasswordRateLimit(ip: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const maxReqs = 5;
  const timestamps = (passwordLoginLimiter.get(ip) || []).filter(t => now - t < window);
  if (timestamps.length >= maxReqs) return false;
  timestamps.push(now);
  passwordLoginLimiter.set(ip, timestamps);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of passwordLoginLimiter) {
    const fresh = ts.filter(t => now - t < 60_000);
    if (fresh.length === 0) passwordLoginLimiter.delete(ip);
    else passwordLoginLimiter.set(ip, fresh);
  }
}, 300_000);

// POST /api/auth/login-password — вход только по паролю (без инвайт-кода)
router.post("/api/auth/login-password", async (req: Request, res: Response) => {
  try {
    // N3 fix: strict rate limiting
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",").pop()?.trim() || req.ip || "unknown";
    if (!checkPasswordRateLimit(clientIp)) {
      return res.status(429).json({ error: "Слишком много попыток. Подождите минуту." });
    }

    const { password, device_id } = req.body;

    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Введите пароль" });
    }

    // N3 fix: limit password length to prevent bcrypt DoS (72 bytes max for bcrypt anyway)
    if (password.length > 128) {
      return res.status(400).json({ error: "Пароль слишком длинный" });
    }

    const supabase = createServiceClient();
    const { data: users, error: dbError } = await supabase
      .from("invite_codes")
      .select("id, code, name, organization, password_hash, device_limit, telegram_chat_id, phone_number, totp_secret, video_seen")
      .not("password_hash", "is", null)
      .eq("is_active", true);

    if (dbError || !users || users.length === 0) {
      // N3 fix: constant-time delay to prevent timing side-channel
      await new Promise(r => setTimeout(r, 200));
      return res.status(401).json({ error: "Неверный пароль" });
    }

    let matched: typeof users[0] | null = null;
    // N3 fix: always compare ALL users to prevent timing leak on user position
    for (const user of users) {
      if (!user.password_hash) continue;
      const valid = await bcrypt.compare(password, user.password_hash);
      if (valid && !matched) {
        matched = user;
        // Don't break — continue comparing to prevent timing leak
      }
    }

    if (!matched) {
      console.warn(`[auth] Failed password login from IP: ${clientIp}`);
      return res.status(401).json({ error: "Неверный пароль" });
    }

    if (device_id) {
      const userAgent = req.headers["user-agent"] || "";
      const { error: deviceError, isNewDevice } = await checkAndRegisterDevice(
        matched.id,
        device_id,
        matched.device_limit ?? null,
        userAgent
      );
      if (deviceError) {
        return res.status(403).json({ error: deviceError });
      }
      if (isNewDevice) {
        notifyNewUser(matched.name, matched.organization).catch(() => {});
      }
    }

    const twoFactorMethods: string[] = [];
    if (matched.telegram_chat_id) twoFactorMethods.push("telegram");
    if (matched.phone_number) twoFactorMethods.push("sms");
    if (matched.totp_secret) twoFactorMethods.push("totp");

    const authToken = generateAuthToken(matched.id);

    return res.json({
      success: true,
      inviteCodeId: matched.id,
      name: matched.name,
      code: matched.code,
      twoFactorMethods,
      authToken,
      videoSeen: !!matched.video_seen,
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// PATCH /api/auth/video-seen — mark onboarding video as watched
router.patch("/api/auth/video-seen", async (req: Request, res: Response) => {
  try {
    // N1 fix: require authentication and verify ownership
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Use authenticated user's own ID — ignore any user-supplied inviteCodeId
    const inviteCodeId = invite.id;

    const supabase = createServiceClient();
    const { error } = await supabase
      .from("invite_codes")
      .update({ video_seen: true })
      .eq("id", inviteCodeId);

    if (error) {
      console.error("[video-seen] DB error:", error.message);
      return res.status(500).json({ error: "Ошибка сохранения" });
    }

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ============================================================
// Admin 2FA routes
// ============================================================

function getAdminTelegramChatId(adminNumber: number): string | null {
  return process.env[`TELEGRAM_ADMIN_CHAT_ID_${adminNumber}`] || null;
}

// GET /api/auth/admin/2fa-status
router.get("/api/auth/admin/2fa-status", async (req: Request, res: Response) => {
  try {
    const adminCode = (req.query.adminCode as string || "").toUpperCase();
    if (!isAdminCode(adminCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const adminNumber = getAdminNumber(adminCode)!;
    const status = await getAdmin2FAStatus(adminNumber);
    const hasTelegramEnv = !!getAdminTelegramChatId(adminNumber);

    return res.json({
      telegram: status.methods.includes("telegram"),
      totp: status.methods.includes("totp"),
      telegramAvailable: hasTelegramEnv,
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/admin/setup-totp
router.post("/api/auth/admin/setup-totp", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, adminSetupTotpSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.adminCode.toUpperCase();
    if (!isAdminCode(upperCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const adminName = getAdminName(upperCode)!;
    const secret = generateTOTPSecret();
    const otpauthUrl = generateTOTPUrl(secret, `Admin: ${adminName}`);

    return res.json({ secret, otpauthUrl });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/admin/verify-setup-totp
router.post("/api/auth/admin/verify-setup-totp", async (req: Request, res: Response) => {
  try {
    const clientIp = getClientIP(req);
    const rl = await checkRateLimit(`admin-2fa-setup:${clientIp}`, 10, 60_000);
    if (rl) {
      return res.status(429).json({ error: "Слишком много попыток" });
    }

    const parsed = parseBody(req.body, adminVerifySetupTotpSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.adminCode.toUpperCase();
    if (!isAdminCode(upperCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const valid = verifyTOTP(parsed.data.otp, parsed.data.totpSecret);
    if (!valid) {
      return res.status(401).json({ error: "Неверный код" });
    }

    const adminNumber = getAdminNumber(upperCode)!;
    const supabase = createServiceClient();

    // Upsert admin_2fa row
    const { data: existing } = await supabase
      .from("admin_2fa")
      .select("id")
      .eq("admin_number", adminNumber)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("admin_2fa")
        .update({ totp_secret: parsed.data.totpSecret, updated_at: new Date().toISOString() })
        .eq("admin_number", adminNumber);
    } else {
      await supabase
        .from("admin_2fa")
        .insert({ admin_number: adminNumber, totp_secret: parsed.data.totpSecret });
    }

    logSecurityEvent("auth.admin_2fa_setup", {
      ip: clientIp,
      userAgent: req.headers["user-agent"] as string,
      details: { adminNumber, method: "totp" },
    });

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/admin/setup-telegram
router.post("/api/auth/admin/setup-telegram", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, adminSetupTelegramSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.adminCode.toUpperCase();
    if (!isAdminCode(upperCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const adminNumber = getAdminNumber(upperCode)!;
    const chatId = getAdminTelegramChatId(adminNumber);
    if (!chatId) {
      return res.status(400).json({
        error: `TELEGRAM_ADMIN_CHAT_ID_${adminNumber} не настроен. Обратитесь к главному администратору.`,
      });
    }

    const withinLimit = await checkAdminOTPRateLimit(adminNumber, "setup_telegram");
    if (!withinLimit) {
      return res.status(429).json({ error: "Слишком много попыток. Подождите." });
    }

    const otp = generateOTP();
    await saveAdminOTP(adminNumber, otp, "setup_telegram", 10);

    const sent = await send2FAMessage(
      `🔐 Код подтверждения для настройки 2FA в СнабЧат: <b>${otp}</b>\n\nКод действителен 10 минут.`,
      chatId
    );

    if (!sent) {
      return res.status(500).json({ error: "Ошибка отправки в Telegram" });
    }

    return res.json({ sent: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/admin/verify-setup-telegram
router.post("/api/auth/admin/verify-setup-telegram", async (req: Request, res: Response) => {
  try {
    const clientIp = getClientIP(req);
    const rl = await checkRateLimit(`admin-2fa-setup:${clientIp}`, 10, 60_000);
    if (rl) {
      return res.status(429).json({ error: "Слишком много попыток" });
    }

    const parsed = parseBody(req.body, adminVerifySetupTelegramSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.adminCode.toUpperCase();
    if (!isAdminCode(upperCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const adminNumber = getAdminNumber(upperCode)!;
    const valid = await verifyAdminOTP(adminNumber, parsed.data.otp, "setup_telegram");
    if (!valid) {
      return res.status(401).json({ error: "Неверный код" });
    }

    const chatId = getAdminTelegramChatId(adminNumber);
    if (!chatId) {
      return res.status(400).json({ error: "Telegram chat ID не настроен" });
    }

    const supabase = createServiceClient();
    const { data: existing } = await supabase
      .from("admin_2fa")
      .select("id")
      .eq("admin_number", adminNumber)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("admin_2fa")
        .update({ telegram_chat_id: chatId, updated_at: new Date().toISOString() })
        .eq("admin_number", adminNumber);
    } else {
      await supabase
        .from("admin_2fa")
        .insert({ admin_number: adminNumber, telegram_chat_id: chatId });
    }

    logSecurityEvent("auth.admin_2fa_setup", {
      ip: clientIp,
      userAgent: req.headers["user-agent"] as string,
      details: { adminNumber, method: "telegram" },
    });

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/admin/send-otp — send OTP for admin login (kept for TOTP path)
router.post("/api/auth/admin/send-otp", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, adminSendOtpSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.adminCode.toUpperCase();
    if (!isAdminCode(upperCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    // Telegram now uses push approval via /api/auth/admin/request-login-approval
    return res.status(400).json({ error: "Для Telegram используйте push-подтверждение" });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/admin/request-login-approval — push-уведомление в Telegram для админа
router.post("/api/auth/admin/request-login-approval", async (req: Request, res: Response) => {
  try {
    const parsed = parseBody(req.body, adminRequestLoginApprovalSchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.adminCode.toUpperCase();
    if (!isAdminCode(upperCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const adminNumber = getAdminNumber(upperCode)!;
    const adminName = getAdminName(upperCode)!;
    const data = await getAdmin2FAData(adminNumber);

    if (!data?.telegram_chat_id) {
      return res.status(400).json({ error: "Telegram не привязан" });
    }

    const supabase = createServiceClient();

    // Expire old pending approvals for this admin
    await supabase
      .from("admin_login_approvals")
      .update({ status: "denied", resolved_at: new Date().toISOString() })
      .eq("admin_number", adminNumber)
      .eq("status", "pending");

    const ipAddress = getClientIP(req);
    const userAgent = req.headers["user-agent"] || "";

    // Geo lookup
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

    // Create approval record
    const { data: approval, error: insertError } = await supabase
      .from("admin_login_approvals")
      .insert({
        admin_number: adminNumber,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .select("id")
      .single();

    if (insertError || !approval) {
      console.error("[admin/request-login-approval] DB error:", insertError?.message);
      return res.status(500).json({ error: "Ошибка создания запроса" });
    }

    // Send push notification with inline buttons
    const locationLine = location ? `\n📍 ${escapeHtml(location)}` : "";
    const text =
      `🔐 <b>Вход в админ-панель СнабЧат</b>\n\n` +
      `Кто-то входит в аккаунт администратора:\n` +
      `👤 <b>${escapeHtml(adminName)}</b>\n` +
      `🌐 ${escapeHtml(ipAddress)}${locationLine}\n` +
      `🕐 ${getMoscowTime()}\n\n` +
      `Это вы?`;

    const replyMarkup = {
      inline_keyboard: [[
        { text: "✅ Да, это я", callback_data: `admin_login_approve:${approval.id}` },
        { text: "❌ Нет, не я", callback_data: `admin_login_deny:${approval.id}` },
      ]],
    };

    const sent = await send2FAMessage(text, data.telegram_chat_id, replyMarkup);
    if (!sent) {
      return res.status(500).json({ error: "Ошибка отправки уведомления в Telegram" });
    }

    return res.json({ approval_id: approval.id });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// GET /api/auth/admin/check-login-approval — polling for admin push approval status
const adminApprovalPollLimiter = new Map<string, number[]>();
function checkAdminApprovalRateLimit(ip: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const maxReqs = 45; // More generous than user (5) since max 3 admins
  const timestamps = (adminApprovalPollLimiter.get(ip) || []).filter(t => now - t < window);
  if (timestamps.length >= maxReqs) return false;
  timestamps.push(now);
  adminApprovalPollLimiter.set(ip, timestamps);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of adminApprovalPollLimiter) {
    const fresh = ts.filter(t => now - t < 60_000);
    if (fresh.length === 0) adminApprovalPollLimiter.delete(ip);
    else adminApprovalPollLimiter.set(ip, fresh);
  }
}, 300_000);

router.get("/api/auth/admin/check-login-approval", async (req: Request, res: Response) => {
  try {
    const clientIp = getClientIP(req);
    if (!checkAdminApprovalRateLimit(clientIp)) {
      return res.status(429).json({ error: "Слишком много запросов" });
    }

    const id = req.query.id as string | undefined;
    const adminCode = (req.query.adminCode as string || "").toUpperCase();

    if (!id) {
      return res.status(400).json({ error: "ID не указан" });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: "Неверный формат ID" });
    }

    if (!isAdminCode(adminCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const adminNumber = getAdminNumber(adminCode)!;
    const supabase = createServiceClient();

    const { data: approval, error } = await supabase
      .from("admin_login_approvals")
      .select("id, admin_number, status, expires_at")
      .eq("id", id)
      .single();

    if (error || !approval) {
      return res.status(404).json({ error: "Запрос не найден" });
    }

    // Verify approval belongs to this admin
    if (approval.admin_number !== adminNumber) {
      return res.status(403).json({ error: "Нет доступа" });
    }

    // Check timeout
    if (approval.status === "pending" && new Date(approval.expires_at) < new Date()) {
      return res.json({ status: "expired" });
    }

    if (approval.status === "approved") {
      // Create session and return admin data
      const adminName = getAdminName(adminCode)!;
      const userAgent = req.headers["user-agent"] || "";
      const adminSessionToken = await generateAdminSessionToken(adminNumber, clientIp, userAgent);

      logSecurityEvent("auth.admin_session_created", {
        ip: clientIp,
        userAgent: userAgent,
        details: { adminNumber, method: "telegram_push" },
      });

      return res.json({
        status: "approved",
        adminName,
        code: adminCode,
        adminSessionToken,
        isDocumentAdmin: isDocumentAdmin(adminCode),
        isPrimaryAdmin: adminNumber === 1,
        canDeleteCodes: isCodeDeletionAdmin(adminCode),
      });
    }

    return res.json({ status: approval.status });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/admin/verify-2fa — verify 2FA and create admin session (TOTP only)
router.post("/api/auth/admin/verify-2fa", async (req: Request, res: Response) => {
  try {
    const clientIp = getClientIP(req);
    const rl = await checkRateLimit(`admin-2fa-verify:${clientIp}`, 10, 60_000);
    if (rl) {
      return res.status(429).json({ error: "Слишком много попыток. Подождите минуту." });
    }

    const parsed = parseBody(req.body, adminVerify2FASchema, res);
    if (parsed.error) return;

    const upperCode = parsed.data.adminCode.toUpperCase();
    if (!isAdminCode(upperCode)) {
      return res.status(401).json({ error: "Неверный админ-код" });
    }

    const adminNumber = getAdminNumber(upperCode)!;
    const adminName = getAdminName(upperCode)!;
    let valid = false;

    if (parsed.data.method === "totp") {
      const data = await getAdmin2FAData(adminNumber);
      if (!data?.totp_secret) {
        return res.status(400).json({ error: "TOTP не настроен" });
      }
      valid = verifyTOTP(parsed.data.otp, data.totp_secret);
    } else if (parsed.data.method === "telegram") {
      // Telegram now uses push approval, not OTP
      return res.status(400).json({ error: "Для Telegram используйте push-подтверждение" });
    }

    if (!valid) {
      logSecurityEvent("auth.admin_2fa_fail", {
        ip: clientIp,
        userAgent: req.headers["user-agent"] as string,
        details: { adminNumber, method: parsed.data.method },
      });
      return res.status(401).json({ error: "Неверный код" });
    }

    // Create admin session
    const userAgent = req.headers["user-agent"] || "";
    const adminSessionToken = await generateAdminSessionToken(adminNumber, clientIp, userAgent);

    logSecurityEvent("auth.admin_session_created", {
      ip: clientIp,
      userAgent: userAgent,
      details: { adminNumber },
    });

    return res.json({
      success: true,
      adminName,
      code: upperCode,
      adminSessionToken,
      isDocumentAdmin: isDocumentAdmin(upperCode),
      isPrimaryAdmin: adminNumber === 1,
      canDeleteCodes: isCodeDeletionAdmin(upperCode),
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

export default router;
