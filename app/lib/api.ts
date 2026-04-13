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
 * Includes x-invite-code, x-auth-token from localStorage, and x-api-key.
 */
export function getAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const code = localStorage.getItem("snabchat_invite_code") || "";
  const token = sessionStorage.getItem("snabchat_auth_token") || "";
  const headers: Record<string, string> = {};
  if (code) headers["x-invite-code"] = encodeURIComponent(code);
  if (token) headers["x-auth-token"] = token;
  if (BACKEND_API_KEY) headers["x-api-key"] = BACKEND_API_KEY;
  return headers;
}
