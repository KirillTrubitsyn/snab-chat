import { Request, Response } from "express";
import { createServiceClient } from "./supabase.js";

// ============================================================
// Захардкоженные админ-коды
// ============================================================

const ADMIN_CODES: Record<string, string> = {
  "ИВАН-АДМИН": "Козлов Иван Евгеньевич",
  "АНДРЕЙ-АДМИН": "Лунев Андрей Эдуардович",
  "КИРИЛЛ-АДМИН": "Трубицын Кирилл Андреевич",
  "ВИТАЛИЙ-АДМИН": "Емельянов Виталий Сергеевич",
};

const ADMIN_NUMBERS: Record<string, number> = {
  "ИВАН-АДМИН": 1,
  "АНДРЕЙ-АДМИН": 2,
  "КИРИЛЛ-АДМИН": 3,
  "ВИТАЛИЙ-АДМИН": 4,
};

export const ADMIN_NAMES_BY_NUMBER: Record<number, string> = {
  1: "Козлов Иван Евгеньевич",
  2: "Лунев Андрей Эдуардович",
  3: "Трубицын Кирилл Андреевич",
  4: "Емельянов Виталий Сергеевич",
};

export function isAdminCode(code: string): boolean {
  return code.toUpperCase() in ADMIN_CODES;
}

export function isDocumentAdmin(code: string): boolean {
  return code.toUpperCase() === "КИРИЛЛ-АДМИН";
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
  if (data.uses_remaining !== null && data.uses_remaining <= 0) return null;
  return data as InviteCode;
}

export async function consumeInviteCode(codeId: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase.rpc("decrement_invite_uses", { code_id: codeId });
}

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

export async function checkAndRegisterDevice(
  inviteCodeId: string,
  deviceId: string,
  deviceLimit: number | null,
  userAgent: string = ""
): Promise<string | null> {
  const supabase = createServiceClient();

  if (deviceLimit === null) {
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

  const { data: existing } = await supabase
    .from("devices")
    .select("id")
    .eq("invite_code_id", inviteCodeId)
    .eq("device_id", deviceId)
    .single();

  if (existing) {
    await supabase
      .from("devices")
      .update({ last_seen_at: new Date().toISOString(), user_agent: userAgent })
      .eq("id", existing.id);
    return null;
  }

  const { count } = await supabase
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("invite_code_id", inviteCodeId);

  if (count !== null && count >= deviceLimit) {
    return `Превышен лимит устройств (${deviceLimit}). Обратитесь к администратору.`;
  }

  await supabase.from("devices").insert({
    invite_code_id: inviteCodeId,
    device_id: deviceId,
    user_agent: userAgent,
  });

  return null;
}

export async function getDeviceCount(inviteCodeId: string): Promise<number> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("invite_code_id", inviteCodeId);
  return count ?? 0;
}

// ============================================================
// Helpers для защиты API-роутов (Express)
// ============================================================

/**
 * Extract and decode header value (handles URI-encoded Cyrillic).
 */
function getHeader(req: Request, name: string): string {
  const raw = (req.headers[name] as string) ?? "";
  if (!raw) return "";
  return decodeURIComponent(raw);
}

export function requireAdmin(
  req: Request,
  res: Response
): { adminName: string } | null {
  const code = getHeader(req, "x-admin-code");
  const name = getAdminName(code);
  if (!name) {
    res.status(401).json({ error: "Требуются права администратора" });
    return null;
  }
  return { adminName: name };
}

export function requireDocumentAdmin(
  req: Request,
  res: Response
): { adminName: string } | null {
  const code = getHeader(req, "x-admin-code");
  if (!isDocumentAdmin(code)) {
    res.status(401).json({ error: "Требуются права администратора" });
    return null;
  }
  return { adminName: getAdminName(code)! };
}

export async function getInviteCodeFromHeader(
  req: Request
): Promise<InviteCode | null> {
  const code = getHeader(req, "x-invite-code");
  if (!code) return null;

  if (isAdminCode(code)) {
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

export async function requireAuth(
  req: Request,
  res: Response
): Promise<{ inviteCodeId: string | null; isAdmin: boolean } | null> {
  const rawInvite = getHeader(req, "x-invite-code");
  const rawAdmin = getHeader(req, "x-admin-code");
  const code = rawInvite || rawAdmin;

  if (isAdminCode(code)) {
    return { inviteCodeId: null, isAdmin: true };
  }

  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    res.status(401).json({ error: "Требуется инвайт-код" });
    return null;
  }

  return { inviteCodeId: invite.id, isAdmin: false };
}
