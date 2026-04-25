/**
 * Signed, path-bound, short-lived tokens for the /api/chunk-image proxy.
 *
 * Audit 24.04.2026 deep-research HIGH-1 fix.
 *
 * The previous implementation passed the user's invite code (or admin code)
 * as a query-string token: `/api/chunk-image?path=...&token=${invite.code}`.
 * That URL ends up in:
 *   - server access logs (Railway, Vercel, any reverse proxy);
 *   - browser history / DevTools / clipboard;
 *   - HTTP Referer when the user clicks any outbound link in the chat;
 *   - public CDN caches because the response was served with
 *     `Cache-Control: public, max-age=86400, immutable`.
 *
 * Plus the route did not check that the requesting user was authorized to
 * read the specific `path` — any valid invite code unlocked any image in
 * the private `chunk-images` bucket.
 *
 * This module replaces that with HMAC-SHA256 tokens bound to:
 *   1. The exact storage path (so a token leak does not unlock other paths);
 *   2. An expiration timestamp (so a leaked URL stops working in <= TTL);
 *   3. A domain-separating label (so an HMAC token signed for a different
 *      purpose with the same secret cannot be replayed here).
 *
 * The signing key reuses the existing `AUTH_TOKEN_SECRET` env var. That
 * secret is already required for backend boot, already 32+ bytes, and
 * already segregated from any other system. Domain separation via the
 * "chunk-image-v1" label keeps purposes from cross-contaminating.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** 1 hour. Long enough that a chat session can scroll and re-render <img>
 *  tags repeatedly without re-fetching, short enough that a leaked URL
 *  stops working before the user logs out. */
export const CHUNK_IMAGE_TOKEN_TTL_MS = 60 * 60 * 1000;

const DOMAIN_LABEL = "chunk-image-v1";

function getSecret(): string {
  const s = process.env.AUTH_TOKEN_SECRET;
  if (!s || s.length < 16) {
    // Fail loudly: deploying without AUTH_TOKEN_SECRET would silently make
    // every signed token verifiable with the empty key.
    throw new Error(
      "AUTH_TOKEN_SECRET is not set or too short. Required by " +
        "chunk-image-token.ts to sign image proxy URLs."
    );
  }
  return s;
}

function payload(path: string, expiresAt: number): string {
  // Concatenation order matters; never feed externally controllable parts
  // before fixed labels, otherwise length-extension-style ambiguity creeps in.
  return `${DOMAIN_LABEL}|${path}|${expiresAt}`;
}

function hmac(input: string): string {
  return createHmac("sha256", getSecret()).update(input).digest("hex");
}

/**
 * Sign a one-shot URL fragment for `path`. Output goes into a query string
 * `&token=<base64url>`. Caller is responsible for URL-encoding.
 */
export function signChunkImageToken(path: string): string {
  const exp = Date.now() + CHUNK_IMAGE_TOKEN_TTL_MS;
  const sig = hmac(payload(path, exp));
  // Base64url over `exp:sig` keeps the path out of the token body — the
  // path is already in the URL as a separate query param. The verifier
  // re-derives the HMAC over (path, exp) and compares with `sig`.
  return Buffer.from(`${exp}:${sig}`, "utf8").toString("base64url");
}

/**
 * Verify a token previously produced by `signChunkImageToken` for the same
 * `path`. Returns true iff (a) token decodes, (b) signature matches under
 * the current secret, (c) expiration is in the future. Timing-safe.
 */
export function verifyChunkImageToken(token: string, path: string): boolean {
  if (!token || !path) return false;
  let raw: string;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const sep = raw.indexOf(":");
  if (sep <= 0) return false;
  const expStr = raw.slice(0, sep);
  const sig = raw.slice(sep + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;

  let expected: string;
  try {
    expected = hmac(payload(path, exp));
  } catch {
    return false;
  }
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
