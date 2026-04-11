import { createServiceClient } from "./supabase.js";

export type SecurityEventType =
  | "auth.password_fail"
  | "auth.otp_fail"
  | "auth.invite_code_fail"
  | "auth.device_limit"
  | "rate_limit.hit"
  | "admin.ip_blocked";

/**
 * Log a security event. Fire-and-forget — never throws.
 */
export async function logSecurityEvent(
  eventType: SecurityEventType,
  params: {
    ip?: string | null;
    userAgent?: string | null;
    inviteCodeId?: string | null;
    details?: Record<string, unknown>;
  } = {}
): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase.from("security_events").insert({
      event_type: eventType,
      ip_address: params.ip ?? null,
      user_agent: params.userAgent ?? null,
      invite_code_id: params.inviteCodeId ?? null,
      details: params.details ?? {},
    });
  } catch (e) {
    console.error("[security-log] Failed to write:", e);
  }
}
