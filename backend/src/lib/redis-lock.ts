/**
 * Generic Redis-backed advisory lock.
 *
 * Used for serializing critical sections that must not run concurrently
 * across multiple backend instances. Two callers today:
 *   - summarization-lock.ts (per-conversation summarization, MEDIUM-5);
 *   - auth.ts checkAndRegisterDevice (per-invite_code device registration,
 *     MEDIUM-4).
 *
 * Acquire is atomic via SET NX EX. Release is atomic via Lua compare-and-
 * delete, so a worker whose lock TTL has expired never accidentally releases
 * a different worker's lock.
 *
 * When no Redis client is configured (`getRedis()` returns null), acquireLock
 * returns NO_REDIS_TOKEN — callers MUST check for this and proceed without
 * serialization (single-instance deploys behave as before; the lock has no
 * effect, but no false serialization either). releaseLock is a no-op for
 * NO_REDIS_TOKEN.
 */

import type Redis from "ioredis";
import { randomUUID } from "node:crypto";

/** Sentinel returned when no Redis is configured; pairs with a no-op release. */
export const NO_REDIS_TOKEN = "no-redis";

/**
 * Try to acquire `key`. Returns:
 *   - a unique token string on success;
 *   - null if another holder owns the lock and TTL is unexpired;
 *   - NO_REDIS_TOKEN if no Redis is configured;
 *   - null on Redis error (fail-closed for serialization, fail-open for
 *     availability via NO_REDIS_TOKEN sentinel only when redis itself is null).
 */
export async function acquireLock(
  redis: Redis | null,
  key: string,
  ttlSec: number
): Promise<string | null> {
  if (!redis) return NO_REDIS_TOKEN;
  const token = randomUUID();
  try {
    const result = await redis.set(key, token, "EX", ttlSec, "NX");
    return result === "OK" ? token : null;
  } catch (err) {
    console.error(`[redis-lock] acquire error on key="${key}":`, err);
    return null;
  }
}

/**
 * Release `key` IFF we still own the same token. Compare-and-delete is
 * atomic via Lua. Errors are swallowed; the lock will eventually expire
 * via TTL anyway.
 */
export async function releaseLock(
  redis: Redis | null,
  key: string,
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
    await redis.eval(SCRIPT, 1, key, token);
  } catch (err) {
    console.error(`[redis-lock] release error on key="${key}":`, err);
  }
}
