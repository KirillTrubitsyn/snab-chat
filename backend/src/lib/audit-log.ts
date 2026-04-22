import { createServiceClient } from "./supabase.js";

export type AuditAction =
  | "invite_code.create"
  | "invite_code.update"
  | "invite_code.delete"
  | "source.delete"
  | "source.update"
  | "source.ingest"
  | "support.reply"
  | "support.delete"
  | "support.status_change"
  | "error_log.delete"
  | "off_topic.delete"
  | "messages.delete"
  | "conversations.delete"
  | "telegram.setup_webhook"
  | "user.disconnect"
  | "infographic.generate"
  | "document.upload"
  | "document.upload.duplicate"
  | "kg.extract_entities";

/**
 * Log an admin action for audit trail.
 * Fire-and-forget — errors are only console.error'd, never thrown.
 */
export async function logAuditEvent(params: {
  action: AuditAction;
  adminName: string;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from("audit_log").insert({
      action: params.action,
      admin_name: params.adminName,
      target_id: params.targetId ?? null,
      details: params.details ?? null,
    });
    if (error) {
      console.error("[audit-log] Failed to write:", error.message);
    }
  } catch (e) {
    console.error("[audit-log] Error:", e);
  }
}
