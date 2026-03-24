import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "./supabase";

// ============================================================
// Захардкоженные админ-коды
// ============================================================

const ADMIN_CODES: Record<string, string> = {
  "ИВАН-АДМИН": "Козлов Иван Евгеньевич",
  "АНДРЕЙ-АДМИН": "Лунев Андрей Эдуардович",
  "КИРИЛЛ-АДМИН": "Трубицын Кирилл Андреевич",
};

// Порядковый номер админа (для отображения пользователю без ФИО)
const ADMIN_NUMBERS: Record<string, number> = {
  "ИВАН-АДМИН": 1,
  "АНДРЕЙ-АДМИН": 2,
  "КИРИЛЛ-АДМИН": 3,
};

// Имена админов по порядковому номеру (для Telegram webhook)
export const ADMIN_NAMES_BY_NUMBER: Record<number, string> = {
  1: "Козлов Иван Евгеньевич",
  2: "Лунев Андрей Эдуардович",
  3: "Трубицын Кирилл Андреевич",
};

export function isAdminCode(code: string): boolean {
  return code.toUpperCase() in ADMIN_CODES;
}

export function getAdminName(code: string): string | null {
  return ADMIN_CODES[code.toUpperCase()] ?? null;
}

export function getAdminNumber(code: string): number | null {
  return ADMIN_NUMBERS[code.toUpperCase()] ?? null;
}

// ============================================================
// Инвайт-коды (БД)
// ============================================================

export interface InviteCode {
  id: string;
  code: string;
  name: string;
  organization: string | null;
  uses_remaining: number | null;
  device_limit: number | null;
  is_active: boolean;
  created_at: string;
}

export async function validateInviteCode(
  code: string
): Promise<InviteCode | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("invite_codes")
    .select("*")
    .eq("code", code.toUpperCase())
    .eq("is_active", true)
    .single();

  if (error || !data) return null;

  // Если есть лимит использований и он исчерпан
  if (data.uses_remaining !== null && data.uses_remaining <= 0) return null;

  return data as InviteCode;
}

export async function consumeInviteCode(codeId: string): Promise<void> {
  const supabase = createServiceClient();
  // Декремент uses_remaining только если он не null
  await supabase.rpc("decrement_invite_uses", { code_id: codeId });
}

// Fallback: если RPC не создана, используем обычный update
export async function consumeInviteCodeFallback(
  codeId: string
): Promise<void> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("invite_codes")
    .select("uses_remaining")
    .eq("id", codeId)
    .single();

  if (data && data.uses_remaining !== null) {
    await supabase
      .from("invite_codes")
      .update({ uses_remaining: data.uses_remaining - 1 })
      .eq("id", codeId);
  }
}

// ============================================================
// Управление устройствами
// ============================================================

/**
 * Проверяет лимит устройств и регистрирует устройство.
 * Возвращает null если всё ок, или строку с ошибкой.
 */
export async function checkAndRegisterDevice(
  inviteCodeId: string,
  deviceId: string,
  deviceLimit: number | null,
  userAgent: string = ""
): Promise<string | null> {
  const supabase = createServiceClient();

  // null = безлимит
  if (deviceLimit === null) {
    // Просто регистрируем/обновляем устройство без проверки лимита
    await supabase
      .from("devices")
      .upsert(
        {
          invite_code_id: inviteCodeId,
          device_id: deviceId,
          user_agent: userAgent,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "invite_code_id,device_id" }
      );
    return null;
  }

  // Проверяем, есть ли уже это устройство
  const { data: existing } = await supabase
    .from("devices")
    .select("id")
    .eq("invite_code_id", inviteCodeId)
    .eq("device_id", deviceId)
    .single();

  if (existing) {
    // Устройство уже зарегистрировано — обновляем last_seen
    await supabase
      .from("devices")
      .update({ last_seen_at: new Date().toISOString(), user_agent: userAgent })
      .eq("id", existing.id);
    return null;
  }

  // Новое устройство — проверяем лимит
  const { count } = await supabase
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("invite_code_id", inviteCodeId);

  if (count !== null && count >= deviceLimit) {
    return `Превышен лимит устройств (${deviceLimit}). Обратитесь к администратору.`;
  }

  // Регистрируем новое устройство
  await supabase.from("devices").insert({
    invite_code_id: inviteCodeId,
    device_id: deviceId,
    user_agent: userAgent,
  });

  return null;
}

/**
 * Получает количество устройств для инвайт-кода.
 */
export async function getDeviceCount(inviteCodeId: string): Promise<number> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("invite_code_id", inviteCodeId);
  return count ?? 0;
}

// ============================================================
// Helpers для защиты API-роутов
// ============================================================

/**
 * Проверяет заголовок X-Admin-Code и возвращает имя админа или 401
 */
export function requireAdmin(
  req: NextRequest
): { adminName: string } | NextResponse {
  const rawCode = req.headers.get("x-admin-code") ?? "";
  const code = decodeURIComponent(rawCode);
  const name = getAdminName(code);
  if (!name) {
    return NextResponse.json(
      { error: "Требуются права администратора" },
      { status: 401 }
    );
  }
  return { adminName: name };
}

/**
 * Извлекает invite_code_id из заголовка X-Invite-Code.
 * Возвращает InviteCode или null.
 */
export async function getInviteCodeFromHeader(
  req: NextRequest
): Promise<InviteCode | null> {
  const rawCode = req.headers.get("x-invite-code") ?? "";
  if (!rawCode) return null;
  // Decode URI-encoded header (Cyrillic characters are not valid in HTTP headers)
  const code = decodeURIComponent(rawCode);

  // Админы тоже могут пользоваться чатом
  if (isAdminCode(code)) {
    // Для админов возвращаем виртуальный объект
    return {
      id: `admin-${code.toUpperCase()}`,
      code: code.toUpperCase(),
      name: getAdminName(code) ?? "Админ",
      organization: "Админ",
      uses_remaining: null,
      device_limit: null,
      is_active: true,
      created_at: new Date().toISOString(),
    };
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("invite_codes")
    .select("*")
    .eq("code", code.toUpperCase())
    .eq("is_active", true)
    .single();

  if (error || !data) return null;
  return data as InviteCode;
}

/**
 * Проверяет, что пользователь авторизован (либо инвайт-код, либо админ).
 * Возвращает invite_code_id для привязки диалогов.
 */
export async function requireAuth(
  req: NextRequest
): Promise<{ inviteCodeId: string | null; isAdmin: boolean } | NextResponse> {
  // Check both x-invite-code and x-admin-code headers (AdminPanel sends x-admin-code)
  const rawInvite = req.headers.get("x-invite-code") ?? "";
  const rawAdmin = req.headers.get("x-admin-code") ?? "";
  const code = decodeURIComponent(rawInvite || rawAdmin);

  if (isAdminCode(code)) {
    return { inviteCodeId: null, isAdmin: true };
  }

  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json(
      { error: "Требуется инвайт-код" },
      { status: 401 }
    );
  }

  return { inviteCodeId: invite.id, isAdmin: false };
}
