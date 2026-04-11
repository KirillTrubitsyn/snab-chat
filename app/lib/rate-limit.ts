/**
 * Distributed sliding window rate limiter.
 * Uses Redis (via globalThis.__redis set in instrumentation.ts) when available,
 * falls back to in-memory for resilience.
 *
 * Redis sorted sets provide an atomic sliding window:
 *   - Each request is a member scored by timestamp
 *   - Expired entries are pruned per check
 *   - A Lua script ensures atomicity
 */

// ── Lua script: atomic sliding window on a sorted set ──
const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local max    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])
local id     = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)
if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if #oldest > 0 then
    return math.max(tonumber(oldest[2]) + window - now, 1)
  end
  return window
end

redis.call('ZADD', key, now, id)
redis.call('PEXPIRE', key, window)
return -1
`;

// ── In-memory fallback (same logic as before) ──

interface RateLimitEntry {
  timestamps: number[];
}

const memoryStore = new Map<string, RateLimitEntry>();
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanupMemory(windowMs: number) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of memoryStore) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) memoryStore.delete(key);
  }
}

function checkMemoryRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { retryAfterMs: number } | null {
  cleanupMemory(windowMs);

  const now = Date.now();
  const cutoff = now - windowMs;

  let entry = memoryStore.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    memoryStore.set(key, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= maxRequests) {
    const oldest = entry.timestamps[0];
    const retryAfterMs = oldest + windowMs - now;
    return { retryAfterMs };
  }

  entry.timestamps.push(now);
  return null;
}

// ── Redis helpers ──

type RedisCheckResult =
  | { status: "allowed" }
  | { status: "limited"; retryAfterMs: number }
  | { status: "unavailable" };

function getRedis(): any {
  const redis = (globalThis as any).__redis;
  if (!redis || redis.status !== "ready") return null;
  return redis;
}

let scriptSha: string | null = null;

async function checkRedisRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RedisCheckResult> {
  const redis = getRedis();
  if (!redis) return { status: "unavailable" };

  const now = Date.now();
  const id = `${now}:${Math.random().toString(36).slice(2, 8)}`;
  const redisKey = `rl:${key}`;

  try {
    let result: number;

    if (scriptSha) {
      try {
        result = await redis.evalsha(
          scriptSha, 1, redisKey, maxRequests, windowMs, now, id
        );
      } catch (err: any) {
        if (err?.message?.includes("NOSCRIPT")) {
          scriptSha = null;
          result = await redis.eval(
            SLIDING_WINDOW_LUA, 1, redisKey, maxRequests, windowMs, now, id
          );
        } else {
          throw err;
        }
      }
    } else {
      scriptSha = await redis.script("LOAD", SLIDING_WINDOW_LUA);
      result = await redis.evalsha(
        scriptSha, 1, redisKey, maxRequests, windowMs, now, id
      );
    }

    if (result === -1) return { status: "allowed" };
    return { status: "limited", retryAfterMs: Math.max(result, 1000) };
  } catch (err) {
    console.error("[rate-limit] Redis error, falling back to in-memory:", err);
    scriptSha = null;
    return { status: "unavailable" };
  }
}

// ── Public API ──

/**
 * Check if the request is rate-limited.
 * Uses Redis when available, in-memory otherwise.
 * @returns `null` if allowed, or `{ retryAfterMs }` if limited.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<{ retryAfterMs: number } | null> {
  const redisResult = await checkRedisRateLimit(key, maxRequests, windowMs);

  switch (redisResult.status) {
    case "allowed":
      return null;
    case "limited":
      return { retryAfterMs: redisResult.retryAfterMs };
    case "unavailable":
      return checkMemoryRateLimit(key, maxRequests, windowMs);
  }
}
