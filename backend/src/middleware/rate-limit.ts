import { Request, Response, NextFunction } from "express";

/**
 * In-memory sliding window rate limiter.
 * Works for single-instance Railway deployments.
 */

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup(windowMs: number) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}

function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { retryAfterMs: number } | null {
  cleanup(windowMs);

  const now = Date.now();
  const cutoff = now - windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
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

// Rate limit config: [maxRequests, windowMs]
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
};

const DEFAULT_LIMIT: [number, number] = [60, 60_000];

function getClientIP(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string") return realIp;
  return req.ip || "unknown";
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const pathname = req.path;

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
  const result = checkRateLimit(key, maxRequests, windowMs);

  if (result) {
    const retryAfter = Math.ceil(result.retryAfterMs / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: "Слишком много запросов. Попробуйте позже.",
    });
  }

  next();
}
