import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import {
  isAdminCode,
  getAdminName,
  getAdminNumber,
  isDocumentAdmin,
  isCodeDeletionAdmin,
  validateInviteCode,
  checkAndRegisterDevice,
} from "../../lib/auth.js";
import {
  loginSchema,
  parseBody,
} from "../../lib/validation.js";
import { createServiceClient } from "../../lib/supabase.js";
import { notifyNewUser } from "../../lib/telegram.js";
import { logSecurityEvent } from "../../lib/security-log.js";
import { getClientIP } from "./helpers.js";

const router = Router();

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

// POST /api/auth/login-password — вход только по паролю (без инвайт-кода)
router.post("/api/auth/login-password", async (req: Request, res: Response) => {
  try {
    const { password, device_id } = req.body;

    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Введите пароль" });
    }

    const supabase = createServiceClient();
    const { data: users, error: dbError } = await supabase
      .from("invite_codes")
      .select("id, code, name, organization, password_hash, device_limit, telegram_chat_id, phone_number, totp_secret")
      .not("password_hash", "is", null)
      .eq("is_active", true);

    if (dbError || !users || users.length === 0) {
      return res.status(401).json({ error: "Неверный пароль" });
    }

    let matched: typeof users[0] | null = null;
    for (const user of users) {
      if (!user.password_hash) continue;
      const valid = await bcrypt.compare(password, user.password_hash);
      if (valid) {
        matched = user;
        break;
      }
    }

    if (!matched) {
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

    return res.json({
      success: true,
      inviteCodeId: matched.id,
      name: matched.name,
      code: matched.code,
      twoFactorMethods,
    });
  } catch {
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

export default router;
