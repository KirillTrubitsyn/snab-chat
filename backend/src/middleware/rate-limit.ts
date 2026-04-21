import { Request, Response, NextFunction } from "express";
import { getRedis } from "../lib/redis.js";

/**
 * Distributed sliding window rate limiter.
 * Uses Redis when available, falls back to in-memory.
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

// ── In-memory fallback ──

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

let scriptSha: string | null = null;

async function checkRedisRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RedisCheckResult> {
  const redis = getRedis();
  if (!redis || redis.status !== "ready") return { status: "unavailable" };

  const now = Date.now();
  const id = `${now}:${Math.random().toString(36).slice(2, 8)}`;
  const redisKey = `rl:${key}`;

  try {
    let result: number;

    if (scriptSha) {
      try {
        result = await redis.evalsha(
          scriptSha, 1, redisKey, maxRequests, windowMs, now, id
        ) as number;
      } catch (err: any) {
        if (err?.message?.includes("NOSCRIPT")) {
          scriptSha = null;
          result = await redis.eval(
            SLIDING_WINDOW_LUA, 1, redisKey, maxRequests, windowMs, now, id
          ) as number;
        } else {
          throw err;
        }
      }
    } else {
      scriptSha = await redis.script("LOAD", SLIDING_WINDOW_LUA) as string;
      result = await redis.evalsha(
        scriptSha, 1, redisKey, maxRequests, windowMs, now, id
      ) as number;
    }

    if (result === -1) return { status: "allowed" };
    return { status: "limited", retryAfterMs: Math.max(result, 1000) };
  } catch (err) {
    console.error("[rate-limit] Redis error, falling back to in-memory:", err);
    scriptSha = null;
    return { status: "unavailable" };
  }
}

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

// ── Rate limit config ──

const RATE_LIMITS: Record<string, [number, number]> = {
  "/api/chat":       [20, 60_000],
  "/api/parse":      [15, 60_000],
  "/api/ingest":     [15, 60_000],
  "/api/search":     [30, 60_000],
  "/api/kb-search":  [30, 60_000],
  "/api/infographic":[5,  60_000],
  "/api/auth/login": [10, 60_000],
  "/api/auth/register": [5, 60_000],
  "/api/support":    [10, 60_000],
  // Extract-entities: тяжёлая LLM-операция (1-3 мин на прогон).
  // 20 запросов в час с запасом перекрывают реальное использование
  // (реально 5-10 прогонов в сутки) и отсекают любой брутфорс.
  "/api/admin/extract-entities": [20, 60 * 60_000],
};

const DEFAULT_LIMIT: [number, number] = [60, 60_000];

function getClientIP(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    // N7 fix: take the LAST IP in the chain — it's the one added by our trusted reverse proxy (Railway).
    // The first IP can be spoofed by the client via X-Forwarded-For header injection.
    const ips = forwarded.split(",").map(s => s.trim()).filter(Boolean);
    return ips[ips.length - 1] || "unknown";
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string") return realIp;
  return req.ip || "unknown";
}

// Admin IP allowlist (empty = no restriction)
const ADMIN_ALLOWED_IPS = (process.env.ADMIN_ALLOWED_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Express middleware ──

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const pathname = req.path;

    // Admin IP allowlist: block admin endpoints from unauthorized IPs
    if (pathname.startsWith("/api/admin") && ADMIN_ALLOWED_IPS.length > 0) {
      const ip = getClientIP(req);
      if (!ADMIN_ALLOWED_IPS.includes(ip)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    // Skip webhook (Telegram sends retries if we reject)
    if (pathname === "/api/telegram/webhook") {
      return next();
    }

    // Only rate-limit API routes
    if (!pathname.startsWith("/api/")) {
      return next();
    }

    const ip = getClientIP(req);

    // Find matching rate limit config (longest prefix match)
    let config = DEFAULT_LIMIT;
    let matchedPath = "/api";
    for (const [path, limit] of Object.entries(RATE_LIMITS)) {
      if (pathname.startsWith(path) && path.length > matchedPath.length) {
        config = limit;
        matchedPath = path;
      }
    }

    const [maxRequests, windowMs] = config;
    const key = `${ip}:${matchedPath}`;
    const result = await checkRateLimit(key, maxRequests, windowMs);

    if (result) {
      const retryAfter = Math.ceil(result.retryAfterMs / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Слишком много запросов. Попробуйте позже.",
      });
    }

    next();
  } catch (err) {
    // Rate limiting should never block the request on internal error
    console.error("[rate-limit] Middleware error:", err);
    next();
  }
}
