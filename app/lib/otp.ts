/**
 * OTP утилиты — генерация, сохранение и проверка одноразовых кодов.
 */

import { randomInt } from "crypto";
import { createServiceClient } from "./supabase";
import { generateSecret, generateURI, verifySync } from "otplib";

/** Генерация 6-значного числового OTP-кода (криптографически безопасный) */
export function generateOTP(): string {
  return String(randomInt(100000, 1000000));
}

/** Сохранить OTP в БД */
export async function saveOTP(
  inviteCodeId: string,
  code: string,
  method: string,
  expiresInMinutes = 5
): Promise<void> {
  const supabase = createServiceClient();
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

  // Инвалидировать предыдущие неиспользованные коды этого метода
  await supabase
    .from("otp_codes")
    .update({ used: true })
    .eq("invite_code_id", inviteCodeId)
    .eq("method", method)
    .eq("used", false);

  await supabase.from("otp_codes").insert({
    invite_code_id: inviteCodeId,
    code,
    method,
    expires_at: expiresAt,
  });
}

/** Проверить OTP из БД */
export async function verifyOTP(
  inviteCodeId: string,
  code: string,
  method: string
): Promise<boolean> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("otp_codes")
    .select("id, expires_at")
    .eq("invite_code_id", inviteCodeId)
    .eq("code", code)
    .eq("method", method)
    .eq("used", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return false;

  // Проверить срок действия
  if (new Date(data.expires_at) < new Date()) return false;

  // Пометить как использованный
  await supabase
    .from("otp_codes")
    .update({ used: true })
    .eq("id", data.id);

  return true;
}

/** Проверить rate limit: макс. отправок в час */
export async function checkOTPRateLimit(
  inviteCodeId: string,
  method: string,
  maxPerHour = 5
): Promise<boolean> {
  const supabase = createServiceClient();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from("otp_codes")
    .select("id", { count: "exact", head: true })
    .eq("invite_code_id", inviteCodeId)
    .eq("method", method)
    .gte("created_at", oneHourAgo);

  if (error) return false;
  return (count ?? 0) < maxPerHour;
}

/** Генерация TOTP-секрета */
export function generateTOTPSecret(): string {
  return generateSecret();
}

/** Генерация otpauth URL для QR-кода */
export function generateTOTPUrl(secret: string, userName: string): string {
  return generateURI({
    issuer: "СнабЧат",
    label: userName,
    secret,
  });
}

/** Проверка TOTP-кода */
export function verifyTOTP(code: string, secret: string): boolean {
  const result = verifySync({ token: code, secret });
  return result.valid;
}
