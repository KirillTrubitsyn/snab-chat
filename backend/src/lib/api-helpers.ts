import { Response } from "express";

/**
 * Standardized API response helpers for Express routes.
 *
 * Format:
 * - Success: { ok: true, ...data }
 * - Error: { error: string }
 */

export function unauthorizedResponse(res: Response) {
  return res.status(401).json({ error: "Требуется инвайт-код" });
}

export function adminRequiredResponse(res: Response) {
  return res.status(401).json({ error: "Требуются права администратора" });
}

export function badRequest(res: Response, message: string) {
  return res.status(400).json({ error: message });
}

export function notFound(res: Response, message = "Не найдено") {
  return res.status(404).json({ error: message });
}

export function serverError(res: Response, message = "Внутренняя ошибка сервера") {
  return res.status(500).json({ error: message });
}

export function ok(res: Response, data?: Record<string, unknown>) {
  return res.json({ ok: true, ...data });
}
