/**
 * Backend API URL helper.
 * When NEXT_PUBLIC_API_URL is set, all API calls go to the external backend (Railway).
 * When empty/unset, calls go to the same-origin Next.js API routes (fallback/development).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

/**
 * Backend API key for request validation.
 * When set, all API requests include x-api-key header to prevent
 * unauthorized direct access to the backend even if its URL leaks.
 */
const BACKEND_API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY || "";

/**
 * Build auth headers for API requests.
 * Includes x-invite-code, x-auth-token from localStorage, и x-admin-session,
 * если пользователь залогинен как админ (для user-scope эндпоинтов, защищённых
 * требованием admin 2FA после H-A).
 */
export function getAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const code = localStorage.getItem("snabchat_invite_code") || "";
  const token = sessionStorage.getItem("snabchat_auth_token") || "";
  const adminSession = sessionStorage.getItem("snabchat_admin_session") || "";
  const headers: Record<string, string> = {};
  if (code) headers["x-invite-code"] = encodeURIComponent(code);
  if (token) headers["x-auth-token"] = token;
  // H-A companion: админский session token, если он сохранён (проверяется validateAdminFastpath на бэкенде)
  if (adminSession) headers["x-admin-session"] = adminSession;
  if (BACKEND_API_KEY) headers["x-api-key"] = BACKEND_API_KEY;
  return headers;
}

/**
 * Build headers for admin API requests.
 * Includes x-admin-code, x-admin-session, and x-api-key.
 */
export function getAdminHeaders(adminCode: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-admin-code": encodeURIComponent(adminCode),
  };
  if (typeof window !== "undefined") {
    const session = sessionStorage.getItem("snabchat_admin_session");
    if (session) headers["x-admin-session"] = session;
  }
  if (BACKEND_API_KEY) headers["x-api-key"] = BACKEND_API_KEY;
  return headers;
}
