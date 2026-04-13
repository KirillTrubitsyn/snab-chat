import crypto from "crypto";

/**
 * Утилита для создания и проверки подписанных краткосрочных токенов для скачивания.
 * Заменяет передачу сырых инвайт-кодов в URL-параметрах.
 */

const SECRET =
  process.env.DOWNLOAD_TOKEN_SECRET ||
  crypto.randomBytes(32).toString("hex");

/**
 * Создаёт подписанный токен для скачивания с ограниченным сроком действия.
 * @param inviteCodeId UUID инвайт-кода
 * @param expiresInMs Время жизни токена (по умолчанию 5 минут)
 */
export function createDownloadToken(
  inviteCodeId: string,
  expiresInMs = 5 * 60 * 1000
): string {
  const expires = Date.now() + expiresInMs;
  const payload = `${inviteCodeId}:${expires}`;
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

/**
 * Проверяет подписанный токен и возвращает inviteCodeId или null.
 */
export function verifyDownloadToken(
  token: string
): { inviteCodeId: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const parts = decoded.split(":");
    if (parts.length < 3) return null;

    const inviteCodeId = parts[0];
    const expiresStr = parts[1];
    const sig = parts.slice(2).join(":");

    if (Date.now() > Number(expiresStr)) return null;

    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`${inviteCodeId}:${expiresStr}`)
      .digest("hex");

    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
    return { inviteCodeId };
  } catch {
    return null;
  }
}
