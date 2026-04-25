/**
 * Per-conversation single-flight for background summarization.
 *
 * Audit 24.04.2026 deep-research MEDIUM-5 fix.
 *
 * Previously `scheduleSummarization` in memory.ts ran fire-and-forget. Two
 * concurrent chat requests on the same conversation crossed the
 * SUMMARIZE_THRESHOLD at the same time → both ran summarization in parallel
 * → both wrote different summaries → both deleted "old" messages, racing
 * over the same row set. Symptoms: occasionally a long conversation lost
 * recent context or had stale summaries reappear.
 *
 * This module provides a Redis-based advisory lock keyed by conversationId.
 * `acquireLock` is atomic via SET NX EX; `releaseLock` uses a Lua
 * compare-and-delete so we never release a lock another worker now owns.
 *
 * Fallback: if no Redis client is available (REDIS_URL unset, dev), returns
 * the sentinel "no-redis". Single-instance deployments behave the same way
 * they did before the fix; the lock has no effect, but no false serialization
 * either. Production has Redis.
 */

import type Redis from "ioredis";
import { randomUUID } from "node:crypto";

/** Sentinel returned when no Redis is configured; pairs with a no-op release. */
export const NO_REDIS_TOKEN = "no-redis";

const KEY_PREFIX = "summary-lock:";

/**
 * 120 seconds. Generous upper bound on a single summarization run
 * (Gemini Flash Lite + supabase update + delete batch usually finishes in
 * <30s). If a worker crashes mid-summarization, the lock auto-expires
 * after 2 minutes and another request can retry.
 */
export const DEFAULT_LOCK_TTL_SEC = 120;

/**
 * Try to acquire the lock for `conversationId`. Returns:
 *   - a unique token string on success (caller must pass it to releaseLock);
 *   - null if another worker already holds the lock;
 *   - `NO_REDIS_TOKEN` if no Redis client is configured (no serialization
 *     possible; caller proceeds as before, no-op release).
 */
export async function acquireLock(
  redis: Redis | null,
  conversationId: string,
  ttlSec: number = DEFAULT_LOCK_TTL_SEC
): Promise<string | null> {
  if (!redis) return NO_REDIS_TOKEN;
  const token = randomUUID();
  try {
    // SET key value NX EX seconds — atomic acquire-with-expiry.
    const result = await redis.set(
      `${KEY_PREFIX}${conversationId}`,
      token,
      "EX",
      ttlSec,
      "NX"
    );
    return result === "OK" ? token : null;
  } catch (err) {
    console.error("[summarization-lock] acquire error:", err);
    return null;
  }
}

/**
 * Release the lock IFF we still own the same token. The compare-and-delete
 * is atomic via Lua, preventing the classic "TTL expired, another worker
 * acquired, original worker finishes and naively deletes someone else's
 * lock" race.
 */
export async function releaseLock(
  redis: Redis | null,
  conversationId: string,
  token: string
): Promise<void> {
  if (token === NO_REDIS_TOKEN || !redis) return;
  const SCRIPT = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await redis.eval(SCRIPT, 1, `${KEY_PREFIX}${conversationId}`, token);
  } catch (err) {
    console.error("[summarization-lock] release error:", err);
  }
}
