import { Router, Request, Response } from "express";
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
import { loginSchema, parseBody } from "../lib/validation.js";
import { notifyNewUser } from "../lib/telegram.js";

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
      return res.status(401).json({
        error: "Неверный или деактивированный инвайт-код",
      });
    }

    // 3. Проверка лимита устройств
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

    // 4. Уменьшаем счётчик использований
    await consumeInviteCodeFallback(invite.id);

    // 5. Уведомление при активации кода с нового устройства
    if (isNewDevice) {
      notifyNewUser(invite.name, invite.organization).catch(() => {});
    }

    return res.json({
      type: "user",
      inviteCodeId: invite.id,
      name: invite.name,
      code: upperCode,
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

export default router;
