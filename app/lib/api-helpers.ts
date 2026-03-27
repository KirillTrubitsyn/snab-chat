import { NextResponse } from "next/server";

/**
 * Стандартизированные хелперы для ответов API-маршрутов.
 *
 * Единый формат ответов:
 * - Успех: { ok: true, ...data }
 * - Ошибка: { error: string }
 */

/** Ответ 401 — не авторизован (инвайт-код) */
export function unauthorizedResponse() {
  return NextResponse.json(
    { error: "Требуется инвайт-код" },
    { status: 401 }
  );
}

/** Ответ 401 — не авторизован (админ) */
export function adminRequiredResponse() {
  return NextResponse.json(
    { error: "Требуются права администратора" },
    { status: 401 }
  );
}

/** Ответ 400 — невалидный запрос */
export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Ответ 404 — не найдено */
export function notFound(message = "Не найдено") {
  return NextResponse.json({ error: message }, { status: 404 });
}

/** Ответ 500 — серверная ошибка */
export function serverError(message = "Внутренняя ошибка сервера") {
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Ответ 200 — успешная операция */
export function ok(data?: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...data });
}
