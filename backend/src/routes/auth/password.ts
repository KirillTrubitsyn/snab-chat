import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import {
  validateInviteCode,
  checkAndRegisterDevice,
} from "../../lib/auth.js";
import {
  setPasswordSchema,
  verifyPasswordSchema,
  changePasswordSchema,
  parseBody,
} from "../../lib/validation.js";
import { createServiceClient } from "../../lib/supabase.js";
import { notifyNewUser } from "../../lib/telegram.js";
import { logSecurityEvent } from "../../lib/security-log.js";
import { getClientIP } from "./helpers.js";

const router = Router();

// POST /api/auth/set-password
router.post("/api/auth/set-password", async (req: Request, res: Response) => {
  try {
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
