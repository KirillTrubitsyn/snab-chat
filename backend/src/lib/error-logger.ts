/**
 * Логирование ошибок в БД (error_logs) + уведомление в Telegram.
 * Fire-and-forget — не бросает исключений.
 *
 * H04 (22.04.2026): перед сохранением/отправкой сообщение прогоняется
 * через sanitizeErrorMessage — вычищаются ключи, токены, JWT и др.
 * Это нужно, потому что ошибки вида "Supabase fetch failed: Bearer eyJ..."
 * регулярно попадают в error_logs и в Telegram-канал алертов; без
 * санитизации секрет оказывается в обеих поверхностях.
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

/**
 * Удаляет потенциально чувствительные данные из строки.
 * Закрывает 4 паттерна:
 *   - key/token/password/secret/authorization=value или : value
 *   - JWT (три base64-сегмента, начинаются с eyJ)
 *   - Google API keys (AIza...)
 *   - Supabase / OpenAI / PAT secrets (sk-, pa-, sb- с 20+ символами)
 * Порядок регексов важен: специфичные паттерны идут первыми.
 */
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/(?:key|token|password|secret|authorization)[=:]\s*\S+/gi, "[СКРЫТО]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[JWT_СКРЫТ]")
    .replace(/AIza[\w-]{30,}/g, "[API_KEY_СКРЫТ]")
    .replace(/(?:sk-|pa-|sb-)[a-zA-Z0-9_-]{20,}/g, "[KEY_СКРЫТ]");
}

/**
 * Рекурсивно санитизирует значения в metadata-объекте.
 * Применяется только к строковым значениям; массивы и вложенные
 * объекты обходятся. Остальные типы (number/boolean/null) не трогаем.
 */
function sanitizeMetadata(meta: Record<string, unknown> | undefined | null):
  Record<string, unknown> | null {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = sanitizeValue(v);
  }
  return out;
}

function sanitizeValue(v: unknown): unknown {
  if (typeof v === "string") return sanitizeErrorMessage(v);
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeValue(sub);
    }
    return out;
  }
  return v;
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
    const sanitizedMetadata = sanitizeMetadata(params.metadata);

    await supabase.from("error_logs").insert({
      error_type: params.type,
      error_message: sanitizedMessage.slice(0, 5000),
      endpoint: params.endpoint ?? null,
      user_name: params.userName ?? null,
      organization: params.organization ?? null,
      invite_code_id: inviteCodeId,
      metadata: sanitizedMetadata,
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
