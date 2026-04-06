/**
 * Логирование ошибок в БД (error_logs) + уведомление в Telegram.
 * Fire-and-forget — не бросает исключений.
 */
import { createServiceClient } from "./supabase.js";
import { notifyError } from "./telegram.js";

interface LogErrorParams {
  type: string;           // chat, parse, ingest, client
  message: string;
  endpoint?: string;
  userName?: string | null;
  organization?: string | null;
  inviteCodeId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logError(params: LogErrorParams): Promise<void> {
  try {
    const supabase = createServiceClient();

    // Не сохраняем invite_code_id если это admin-xxx
    const inviteCodeId =
      params.inviteCodeId && !params.inviteCodeId.startsWith("admin-")
        ? params.inviteCodeId
        : null;

    await supabase.from("error_logs").insert({
      error_type: params.type,
      error_message: params.message.slice(0, 5000),
      endpoint: params.endpoint ?? null,
      user_name: params.userName ?? null,
      organization: params.organization ?? null,
      invite_code_id: inviteCodeId,
      metadata: params.metadata ?? null,
    });

    // Telegram (fire-and-forget)
    notifyError(
      params.type,
      params.message,
      params.userName,
      params.endpoint,
      params.organization
    ).catch(() => {});
  } catch (e) {
    console.error("[ErrorLogger] Не удалось записать ошибку:", e);
  }
}
