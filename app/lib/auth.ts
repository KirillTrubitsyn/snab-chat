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

export function isAdminCode(code: string): boolean {
  return code.toUpperCase() in ADMIN_CODES;
}

export function getAdminName(code: string): string | null {
  return ADMIN_CODES[code.toUpperCase()] ?? null;
}

// ============================================================
// Инвайт-коды (БД)
// ============================================================

export interface InviteCode {
  id: string;
  code: string;
  name: string;
  uses_remaining: number | null;
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
      uses_remaining: null,
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
  const rawCode = req.headers.get("x-invite-code") ?? "";
  const code = decodeURIComponent(rawCode);

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
