/**
 * Логирование ошибок в БД (error_logs) + уведомление в Telegram.
 * Fire-and-forget — не бросает исключений.
 */
import { createServiceClient } from "./supabase";
import { notifyError } from "./telegram";

interface LogErrorParams {
  type: string;           // chat, parse, ingest, client
  message: string;
  endpoint?: string;
  userName?: string | null;
  organization?: string | null;
  inviteCodeId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Удаляет потенциально чувствительные данные из сообщений об ошибках */
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/(?:key|token|password|secret|authorization)[=:]\s*\S+/gi, "[СКРЫТО]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[JWT_СКРЫТ]")
    .replace(/AIza[\w-]{30,}/g, "[API_KEY_СКРЫТ]")
    .replace(/(?:sk-|pa-|sb-)[a-zA-Z0-9_-]{20,}/g, "[KEY_СКРЫТ]");
}

export async function logError(params: LogErrorParams): Promise<void> {
  try {
    const supabase = createServiceClient();

    // Не сохраняем invite_code_id если это admin-xxx
    const inviteCodeId =
      params.inviteCodeId && !params.inviteCodeId.startsWith("admin-")
        ? params.inviteCodeId
        : null;

    const sanitizedMessage = sanitizeErrorMessage(params.message);

    await supabase.from("error_logs").insert({
      error_type: params.type,
      error_message: sanitizedMessage.slice(0, 5000),
      endpoint: params.endpoint ?? null,
      user_name: params.userName ?? null,
      organization: params.organization ?? null,
      invite_code_id: inviteCodeId,
      metadata: params.metadata ?? null,
    });

    // Telegram (fire-and-forget)
    notifyError(
      params.type,
      sanitizedMessage,
      params.userName,
      params.endpoint,
      params.organization
    ).catch(() => {});
  } catch (e) {
    console.error("[ErrorLogger] Не удалось записать ошибку:", e);
  }
}
