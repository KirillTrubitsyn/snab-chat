import { Request, Response } from "express";
import { createServiceClient } from "./supabase.js";

// ============================================================
// Админ-коды из переменной окружения ADMIN_CODES_JSON
// Формат: [{"code":"ADMIN-CODE","name":"Full Name","number":1,"isDocAdmin":false}, ...]
// ============================================================

interface AdminEntry {
  code: string;
  name: string;
  number: number;
  isDocAdmin?: boolean;
  canDeleteCodes?: boolean;
}

function loadAdminCodes(): AdminEntry[] {
  const raw = process.env.ADMIN_CODES_JSON;
  if (!raw) {
    console.warn("[auth] ADMIN_CODES_JSON not set — no admin codes configured");
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Expected array");
    return parsed.map((e: Record<string, unknown>) => ({
      code: String(e.code).toUpperCase(),
      name: String(e.name),
      number: Number(e.number),
      isDocAdmin: Boolean(e.isDocAdmin),
      canDeleteCodes: Boolean(e.canDeleteCodes),
    }));
  } catch (err) {
    console.error("[auth] Failed to parse ADMIN_CODES_JSON:", err);
    return [];
  }
}

let _adminEntries: AdminEntry[] | null = null;
function getAdminEntries(): AdminEntry[] {
  if (!_adminEntries) _adminEntries = loadAdminCodes();
  return _adminEntries;
}

function getAdminCodesMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of getAdminEntries()) map[e.code] = e.name;
  return map;
}

function getAdminNumbersMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const e of getAdminEntries()) map[e.code] = e.number;
  return map;
}

export function getAdminNamesByNumber(): Record<number, string> {
  const map: Record<number, string> = {};
  for (const e of getAdminEntries()) map[e.number] = e.name;
  return map;
}

export const ADMIN_NAMES_BY_NUMBER: Record<number, string> = new Proxy(
  {} as Record<number, string>,
  {
    get(_, prop) {
      return getAdminNamesByNumber()[prop as unknown as number];
    },
    ownKeys() {
      return Object.keys(getAdminNamesByNumber());
    },
    getOwnPropertyDescriptor(_, prop) {
      const map = getAdminNamesByNumber();
      if (prop in map) {
        return { enumerable: true, configurable: true, value: map[prop as unknown as number] };
      }
      return undefined;
    },
  }
);

export function isAdminCode(code: string): boolean {
  return code.toUpperCase() in getAdminCodesMap();
}

export function isDocumentAdmin(code: string): boolean {
  const entry = getAdminEntries().find((e) => e.code === code.toUpperCase());
  return entry?.isDocAdmin === true;
}

export function isCodeDeletionAdmin(code: string): boolean {
  const entry = getAdminEntries().find((e) => e.code === code.toUpperCase());
  return entry?.canDeleteCodes === true;
}

export function getAdminName(code: string): string | null {
  return getAdminCodesMap()[code.toUpperCase()] ?? null;
}

export function getAdminNumber(code: string): number | null {
  return getAdminNumbersMap()[code.toUpperCase()] ?? null;
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
  chat_limit: number | null;
  infographic_limit: number | null;
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
): Promise<{ error: string | null; isNewDevice: boolean }> {
  const supabase = createServiceClient();

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
    return { error: null, isNewDevice: false };
  }

  if (deviceLimit !== null) {
    const { count } = await supabase
      .from("devices")
      .select("id", { count: "exact", head: true })
      .eq("invite_code_id", inviteCodeId);

    if (count !== null && count >= deviceLimit) {
      return {
        error: `Превышен лимит устройств (${deviceLimit}). Обратитесь к администратору.`,
        isNewDevice: false,
      };
    }
  }

  await supabase.from("devices").insert({
    invite_code_id: inviteCodeId,
    device_id: deviceId,
    user_agent: userAgent,
  });

  return { error: null, isNewDevice: true };
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
      chat_limit: null,
      infographic_limit: null,
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
