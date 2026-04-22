import { Request } from "express";
import { timingSafeEqual } from "crypto";
import { getAdminName, getAdminNumber } from "./auth.js";

/**
 * Service-auth для межсервисных вызовов без браузерной 2FA-сессии.
 *
 * Дизайн (H03, 22.04.2026):
 *   - Всё, что ходит в бэкенд "из скриптов" (без Origin header), обязано
 *     предъявить (а) секретный EXTRACTION_SERVICE_KEY и (б) админ-код
 *     сервис-аккаунта (admin_number === SERVICE_AUTH_ADMIN_NUMBER).
 *   - Живые админы (1, 2, …) service-путь использовать НЕ могут —
 *     они ходят через браузер с 2FA-сессией.
 *   - До H03 был третий путь — "fastpath": админ-код без 2FA, если у
 *     админа не настроен TOTP/Telegram. Этот путь удалён целиком как
 *     лишняя дырка в модели угроз.
 *
 * Сервис-аккаунт: admin_number === 4, код хранится в ENV, живым людям
 * не выдаётся. Компрометация кода ≈ компрометация ENV (одинаковая
 * модель утечки), отдельной поверхности атаки не добавляет.
 *
 * SECURITY:
 *   - Сравнение ключа timing-safe (crypto.timingSafeEqual).
 *   - При любой неудаче возвращаем null без деталей — чтобы злоумышленник
 *     не мог перечислять валидные ключи/коды по таймингу или тексту ошибки.
 *   - Минимальная длина EXTRACTION_SERVICE_KEY — 32 байта.
 */

export const SERVICE_AUTH_ADMIN_NUMBER = 4;

export interface ServiceAuthContext {
  adminName: string;
  adminNumber: number;
  authMethod: "service";
}

function decodeHeader(raw: string | string[] | undefined): string {
  if (!raw) return "";
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Проверяет service-auth headers на запросе.
 * Возвращает контекст успеха либо null при любой неудаче.
 *
 * Условия успеха (все три обязательны):
 *   1. EXTRACTION_SERVICE_KEY задан в ENV, длина ≥ 32.
 *   2. x-api-key совпадает с ним (timing-safe).
 *   3. x-admin-code соответствует admin_number === SERVICE_AUTH_ADMIN_NUMBER.
 */
export function tryServiceAuth(req: Request): ServiceAuthContext | null {
  const serviceKey = process.env.EXTRACTION_SERVICE_KEY;
  if (!serviceKey || serviceKey.length < 32) return null;

  const providedKey = decodeHeader(req.headers["x-api-key"]);
  if (!providedKey) return null;

  const aBuf = Buffer.from(providedKey);
  const bBuf = Buffer.from(serviceKey);
  if (aBuf.length !== bBuf.length) return null;
  try {
    if (!timingSafeEqual(aBuf, bBuf)) return null;
  } catch {
    return null;
  }

  const adminCode = decodeHeader(req.headers["x-admin-code"]);
  if (!adminCode) return null;

  const adminNumber = getAdminNumber(adminCode);
  if (adminNumber !== SERVICE_AUTH_ADMIN_NUMBER) return null;

  const name = getAdminName(adminCode);
  if (!name) return null;

  return {
    adminName: name,
    adminNumber,
    authMethod: "service",
  };
}

/**
 * Проверяет service-auth headers без привязки к конкретному объекту
 * Request (используется в middleware до парсинга).
 */
export function isValidServiceAuthFromHeaders(req: Request): boolean {
  return tryServiceAuth(req) !== null;
}
