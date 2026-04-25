/**
 * Per-conversation single-flight for background summarization (MEDIUM-5).
 *
 * Thin domain wrapper over `redis-lock.ts`. Pinned key prefix
 * `summary-lock:` keeps the namespace separate from the device-register
 * prefix used in auth.ts.
 */

import type Redis from "ioredis";
import {
  acquireLock as acquire,
  releaseLock as release,
  NO_REDIS_TOKEN,
} from "./redis-lock.js";

export { NO_REDIS_TOKEN };

/**
 * 120 seconds. Generous upper bound on a single summarization run
 * (Gemini Flash Lite + supabase update + delete batch usually finishes in
 * <30s). If a worker crashes mid-run, the lock auto-expires after 2 minutes.
 */
export const DEFAULT_LOCK_TTL_SEC = 120;

const KEY_PREFIX = "summary-lock:";

export function acquireLock(
  redis: Redis | null,
  conversationId: string,
  ttlSec: number = DEFAULT_LOCK_TTL_SEC
): Promise<string | null> {
  return acquire(redis, `${KEY_PREFIX}${conversationId}`, ttlSec);
}

export function releaseLock(
  redis: Redis | null,
  conversationId: string,
  token: string
): Promise<void> {
  return release(redis, `${KEY_PREFIX}${conversationId}`, token);
}
