/**
 * Admin OTP utilities -- generation, storage and verification of one-time codes for admins.
 * Parallel to otp.ts but uses admin_otp_codes table keyed by admin_number.
 */

import { createServiceClient } from "./supabase.js";
import { generateOTP } from "./otp.js";

export { generateOTP };

/** Save admin OTP to the database */
export async function saveAdminOTP(
  adminNumber: number,
  code: string,
  method: string,
  expiresInMinutes = 5
): Promise<void> {
  const supabase = createServiceClient();
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

  // Invalidate previous unused codes for this method
  await supabase
    .from("admin_otp_codes")
    .update({ used: true })
    .eq("admin_number", adminNumber)
    .eq("method", method)
    .eq("used", false);

  const { error } = await supabase.from("admin_otp_codes").insert({
    admin_number: adminNumber,
    code,
    method,
    expires_at: expiresAt,
  });
  if (error) {
    console.error("[AdminOTP] Insert error:", error.message);
    throw new Error(`Failed to save admin OTP: ${error.message}`);
  }
}

/** Verify admin OTP from the database */
export async function verifyAdminOTP(
  adminNumber: number,
  code: string,
  method: string
): Promise<boolean> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("admin_otp_codes")
    .select("id, expires_at")
    .eq("admin_number", adminNumber)
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
    .from("admin_otp_codes")
    .update({ used: true })
    .eq("id", data.id);

  return true;
}

/** Check rate limit for admin OTP: max sends per hour */
export async function checkAdminOTPRateLimit(
  adminNumber: number,
  method: string,
  maxPerHour = 5
): Promise<boolean> {
  const supabase = createServiceClient();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from("admin_otp_codes")
    .select("id", { count: "exact", head: true })
    .eq("admin_number", adminNumber)
    .eq("method", method)
    .gte("created_at", oneHourAgo);

  if (error) return false;
  return (count ?? 0) < maxPerHour;
}
