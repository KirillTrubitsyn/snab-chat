import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/app/lib/rate-limit";

// Rate limit config: [maxRequests, windowMs]
const RATE_LIMITS: Record<string, [number, number]> = {
  "/api/chat":       [20, 60_000],   // 20 req/min — LLM calls are expensive
  "/api/parse":      [15, 60_000],   // 15 req/min — file parsing
  "/api/ingest":     [15, 60_000],   // 15 req/min — indexing
  "/api/search":     [30, 60_000],   // 30 req/min — search
  "/api/kb-search":  [30, 60_000],   // 30 req/min — kb search
  "/api/eval-reranker": [2, 60_000], // 2 req/min — expensive diagnostics endpoint
  "/api/infographic":[5,  60_000],   // 5 req/min — heavy LLM + image
  "/api/auth/login": [10, 60_000],   // 10 req/min — brute-force protection
  "/api/auth/login-password": [5, 60_000], // 5 req/min — password-only login (bcrypt-heavy)
  "/api/auth/verify-password": [10, 60_000], // 10 req/min — password check before 2FA
  "/api/auth/verify-otp": [8, 60_000], // 8 req/min — OTP brute-force reduction
  "/api/auth/verify-setup-otp": [6, 60_000], // 6 req/min — setup OTP brute-force reduction
  "/api/auth/send-otp": [6, 60_000], // 6 req/min — OTP delivery abuse reduction
  "/api/auth/setup-totp": [4, 60_000], // 4 req/min — TOTP setup abuse reduction
  "/api/auth/register": [5, 60_000], // 5 req/min — registration
  "/api/support":    [10, 60_000],   // 10 req/min — support messages
};

// Default limit for all other API routes
const DEFAULT_LIMIT: [number, number] = [60, 60_000]; // 60 req/min

function getClientIP(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// Mutation endpoints that require valid Origin/Referer
const ORIGIN_PROTECTED_PATHS = [
  "/api/infographic",
  "/api/chat",
  "/api/parse",
  "/api/ingest",
  "/api/auth",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only rate-limit API routes
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Skip webhook (Telegram sends retries if we reject)
  if (pathname === "/api/telegram/webhook") {
    return NextResponse.next();
  }

  // Block POST requests without valid Origin/Referer on sensitive endpoints
  // Prevents direct API calls via curl/Postman/scripts
  if (req.method === "POST" && ORIGIN_PROTECTED_PATHS.some((p) => pathname.startsWith(p))) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    const host = req.headers.get("host") || "";
    const hostWithoutPort = host.split(":")[0];
    // Accept if Origin or Referer contains the same host as the request
    const matchesHost = (val: string) => {
      try {
        const url = new URL(val);
        return url.hostname === hostWithoutPort || url.hostname === "localhost";
      } catch { return false; }
    };
    const validOrigin = origin && matchesHost(origin);
    const validReferer = referer && matchesHost(referer);
    if (!validOrigin && !validReferer) {
      return NextResponse.json(
        { error: "Запрос отклонён" },
        { status: 403 }
      );
    }
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
    return NextResponse.json(
      { error: "Слишком много запросов. Попробуйте позже." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
