/**
 * OTP utilities -- generation, storage and verification of one-time codes.
 */

import { createServiceClient } from "./supabase.js";
import { generateSecret, generateURI, verifySync } from "otplib";

/** Generate a 6-digit numeric OTP code */
export function generateOTP(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Save OTP to the database */
export async function saveOTP(
  inviteCodeId: string,
  code: string,
  method: string,
  expiresInMinutes = 5
): Promise<void> {
  const supabase = createServiceClient();
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

  // Invalidate previous unused codes for this method
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

/** Verify OTP from the database */
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

  // Check expiration
  if (new Date(data.expires_at) < new Date()) return false;

  // Mark as used
  await supabase
    .from("otp_codes")
    .update({ used: true })
    .eq("id", data.id);

  return true;
}

/** Check rate limit: max sends per hour */
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

/** Generate TOTP secret */
export function generateTOTPSecret(): string {
  return generateSecret();
}

/** Generate otpauth URL for QR code */
export function generateTOTPUrl(secret: string, userName: string): string {
  return generateURI({
    issuer: "\u0421\u043d\u0430\u0431\u0427\u0430\u0442",
    label: userName,
    secret,
  });
}

/** Verify TOTP code */
export function verifyTOTP(code: string, secret: string): boolean {
  const result = verifySync({ token: code, secret });
  return result.valid;
}
