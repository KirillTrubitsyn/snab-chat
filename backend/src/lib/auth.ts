import { Request, Response } from "express";
import { createHmac, timingSafeEqual, randomBytes, createHash } from "crypto";
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

// Timing-safe admin entry lookup — iterates all entries to prevent timing leaks
function findAdminEntry(code: string): AdminEntry | null {
  const upperCode = code.toUpperCase();
  let found: AdminEntry | null = null;
  for (const entry of getAdminEntries()) {
    const a = Buffer.from(entry.code);
    const b = Buffer.from(upperCode);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      found = entry;
    }
  }
  return found;
}

export function isAdminCode(code: string): boolean {
  return findAdminEntry(code) !== null;
}

export function isDocumentAdmin(code: string): boolean {
  return findAdminEntry(code)?.isDocAdmin === true;
}

export function isCodeDeletionAdmin(code: string): boolean {
  return findAdminEntry(code)?.canDeleteCodes === true;
}

export function getAdminName(code: string): string | null {
  return findAdminEntry(code)?.name ?? null;
}

export function getAdminNumber(code: string): number | null {
  return findAdminEntry(code)?.number ?? null;
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
  video_seen?: boolean;
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
  return data as InviteCode;
}

// ============================================================
// Управление устройствами
// ============================================================

function isMobileUserAgent(userAgent: string): boolean {
  return /mobile|android|iphone|ipad|ipod|blackberry|windows phone|webos/i.test(userAgent);
}

export async function checkAndRegisterDevice(
  inviteCodeId: string,
  deviceId: string,
  deviceLimit: number | null,
  userAgent: string = ""
): Promise<{ error: string | null; isNewDevice: boolean; deviceNumber: number; isMobile: boolean }> {
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
    return { error: null, isNewDevice: false, deviceNumber: 0, isMobile: false };
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
        deviceNumber: 0,
        isMobile: false,
      };
    }
  }

  await supabase.from("devices").insert({
    invite_code_id: inviteCodeId,
    device_id: deviceId,
    user_agent: userAgent,
  });

  const { count: newCount } = await supabase
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("invite_code_id", inviteCodeId);

  return { error: null, isNewDevice: true, deviceNumber: newCount ?? 1, isMobile: isMobileUserAgent(userAgent) };
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
// Auth tokens (HMAC-based stateless session tokens)
// ============================================================

/**
 * M-D fix: выделенный секрет для подписи auth-токенов.
 *
 * Приоритет источников:
 *   1. AUTH_TOKEN_SECRET (рекомендуется, >= 32 байт случайности, hex/base64)
 *   2. Устаревший fallback на SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY
 *      — сохранён для backwards-compat, чтобы ротация ENV не разлогинила всех пользователей.
 *      При использовании fallback в лог пишется WARN, чтобы было видно необходимость миграции.
 *   3. Эфемерный ключ на время процесса (токены не переживут рестарт).
 *
 * Ротация AUTH_TOKEN_SECRET инвалидирует ВСЕ выпущенные auth-токены.
 * Это безопасный способ принудительно разлогинить сессии.
 */
const AUTH_TOKEN_SECRET = (() => {
  if (process.env.AUTH_TOKEN_SECRET && process.env.AUTH_TOKEN_SECRET.length >= 32) {
    return process.env.AUTH_TOKEN_SECRET;
  }
  const legacy = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (legacy) {
    console.warn(
      "[auth] WARNING: AUTH_TOKEN_SECRET not set — using legacy fallback on SUPABASE_SERVICE_*_KEY. " +
      "Set a dedicated AUTH_TOKEN_SECRET (>=32 chars, e.g. `openssl rand -hex 32`) to decouple token signing from the database key. " +
      "This is a migration path; fallback will be removed in a future release."
    );
    return legacy;
  }
  console.warn("[auth] WARNING: No auth token secret configured — using random ephemeral key. Tokens will NOT survive restarts.");
  return randomBytes(32).toString("hex");
})();
const AUTH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Generate a signed auth token after successful password/2FA verification.
 * Format: inviteCodeId:timestamp:hmacSignature
 */
export function generateAuthToken(inviteCodeId: string): string {
  const timestamp = Date.now().toString();
  const payload = `${inviteCodeId}:${timestamp}`;
  const signature = createHmac("sha256", AUTH_TOKEN_SECRET)
    .update(payload)
    .digest("hex");
  return `${payload}:${signature}`;
}

/**
 * Verify an auth token: check HMAC signature, expiration, and that it
 * belongs to the expected invite code.
 */
export function verifyAuthToken(
  token: string,
  expectedInviteCodeId: string
): boolean {
  const parts = token.split(":");
  if (parts.length !== 3) return false;

  const [inviteCodeId, timestampStr, providedSig] = parts;
  if (inviteCodeId !== expectedInviteCodeId) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  const age = Date.now() - timestamp;
  if (age > AUTH_TOKEN_MAX_AGE_MS || age < 0) return false;

  const expectedSig = createHmac("sha256", AUTH_TOKEN_SECRET)
    .update(`${inviteCodeId}:${timestampStr}`)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(providedSig, "hex"),
      Buffer.from(expectedSig, "hex")
    );
  } catch {
    return false;
  }
}

// ============================================================
// Admin 2FA: session tokens (DB-backed for revocability)
// ============================================================

const ADMIN_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Get admin 2FA data from DB.
 */
export async function getAdmin2FAData(
  adminNumber: number
): Promise<{ totp_secret: string | null; telegram_chat_id: string | null } | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("admin_2fa")
    .select("totp_secret, telegram_chat_id")
    .eq("admin_number", adminNumber)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Get admin 2FA status: which methods are configured.
 */
export async function getAdmin2FAStatus(
  adminNumber: number
): Promise<{ hasAnyMethod: boolean; methods: string[] }> {
  const data = await getAdmin2FAData(adminNumber);
  const methods: string[] = [];
  if (data?.totp_secret) methods.push("totp");
  if (data?.telegram_chat_id) methods.push("telegram");
  return { hasAnyMethod: methods.length > 0, methods };
}

/**
 * Generate admin session token after successful 2FA verification.
 * Stores SHA-256 hash in admin_sessions table; returns the raw token.
 */
export async function generateAdminSessionToken(
  adminNumber: number,
  ip: string,
  userAgent: string
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_MAX_AGE_MS).toISOString();

  const supabase = createServiceClient();
  await supabase.from("admin_sessions").insert({
    admin_number: adminNumber,
    token_hash: tokenHash,
    ip_address: ip,
    user_agent: userAgent,
    expires_at: expiresAt,
  });

  return token;
}

/**
 * Verify admin session token: hash, look up in DB, check expiry.
 */
export async function verifyAdminSessionToken(
  token: string
): Promise<{ adminNumber: number } | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("admin_sessions")
    .select("admin_number, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data) return null;

  // Check expiration
  if (new Date(data.expires_at) < new Date()) {
    // Clean up expired session
    await supabase.from("admin_sessions").delete().eq("token_hash", tokenHash);
    return null;
  }

  return { adminNumber: data.admin_number };
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
  // N12 fix: decodeURIComponent throws on malformed percent-encoding
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function requireAdmin(
  req: Request,
  res: Response
): Promise<{ adminName: string; adminNumber: number } | null> {
  const code = getHeader(req, "x-admin-code");
  const name = getAdminName(code);
  if (!name) {
    res.status(401).json({ error: "Требуются права администратора" });
    return null;
  }

  const adminNumber = getAdminNumber(code)!;
  const sessionToken = getHeader(req, "x-admin-session");

  if (!sessionToken) {
    res.status(401).json({ error: "Требуется 2FA авторизация" });
    return null;
  }

  const session = await verifyAdminSessionToken(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Сессия истекла, войдите заново" });
    return null;
  }

  if (session.adminNumber !== adminNumber) {
    res.status(401).json({ error: "Несоответствие сессии" });
    return null;
  }

  return { adminName: name, adminNumber };
}

export async function requireDocumentAdmin(
  req: Request,
  res: Response
): Promise<{ adminName: string } | null> {
  const code = getHeader(req, "x-admin-code");
  if (!isDocumentAdmin(code)) {
    res.status(401).json({ error: "Требуются права администратора" });
    return null;
  }

  const sessionToken = getHeader(req, "x-admin-session");
  if (!sessionToken) {
    res.status(401).json({ error: "Требуется 2FA авторизация" });
    return null;
  }

  const session = await verifyAdminSessionToken(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Сессия истекла, войдите заново" });
    return null;
  }

  return { adminName: getAdminName(code)! };
}

/**
 * H-A fix: проверяет допустимость fastpath по админ-коду с учётом состояния 2FA.
 *
 * Правила (в порядке приоритета):
 *  1. Если передан валидный x-admin-session, соответствующий этому админу → разрешаем.
 *  2. Если для админа НЕ настроен ни один 2FA-метод (TOTP/Telegram) → разрешаем
 *     (миграционный backwards-compat окно, чтобы не сломать первичный setup-флоу
 *     до того, как все админы пройдут настройку 2FA).
 *  3. Иначе (2FA настроено, но session отсутствует/невалиден) → отклоняем.
 */
async function validateAdminFastpath(req: Request, code: string): Promise<boolean> {
  const adminNumber = getAdminNumber(code);
  if (adminNumber === null) return false;

  const sessionToken = getHeader(req, "x-admin-session");
  if (sessionToken) {
    const session = await verifyAdminSessionToken(sessionToken);
    if (session && session.adminNumber === adminNumber) {
      return true;
    }
  }

  const status = await getAdmin2FAStatus(adminNumber);
  if (!status.hasAnyMethod) {
    // 2FA ещё не настроено — временно разрешаем fastpath
    return true;
  }

  return false;
}

export async function getInviteCodeFromHeader(
  req: Request
): Promise<InviteCode | null> {
  const code = getHeader(req, "x-invite-code");
  if (!code) return null;

  if (isAdminCode(code)) {
    // H-A fix: fastpath пропускает админ-код только если либо присутствует валидный
    // admin session token, либо 2FA у этого админа ещё не настроено (backwards-compat).
    const ok = await validateAdminFastpath(req, code);
    if (!ok) {
      console.warn(
        `[auth] Rejected admin fastpath for ***${code.slice(-3).toUpperCase()}: 2FA required but session missing/invalid`
      );
      return null;
    }
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
    .select("*, password_hash")
    .eq("code", code.toUpperCase())
    .eq("is_active", true)
    .single();

  if (error || !data) return null;

  // SECURITY: ALWAYS require a valid auth token for API access.
  // Auth tokens are issued only after password creation (set-password)
  // or password verification (verify-password / login-password).
  // This ensures that invite code alone is never sufficient —
  // users MUST set a password on first login and authenticate with it thereafter.
  const authToken = getHeader(req, "x-auth-token");
  if (!authToken || !verifyAuthToken(authToken, data.id)) {
    console.warn(
      `[auth] Rejected request for code ***${code.slice(-3).toUpperCase()}: auth token is missing or invalid`
    );
    return null;
  }

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
    // H-A fix: admin-fastpath только при наличии валидной admin session или до настройки 2FA.
    const ok = await validateAdminFastpath(req, code);
    if (!ok) {
      res.status(401).json({ error: "Требуется 2FA авторизация администратора" });
      return null;
    }
    return { inviteCodeId: null, isAdmin: true };
  }

  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    res.status(401).json({ error: "Требуется инвайт-код" });
    return null;
  }

  return { inviteCodeId: invite.id, isAdmin: false };
}
