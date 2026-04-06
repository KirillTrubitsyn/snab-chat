/**
 * Backend API URL helper.
 * When NEXT_PUBLIC_API_URL is set, all API calls go to the external backend (Railway).
 * When empty/unset, calls go to the same-origin Next.js API routes (fallback/development).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
