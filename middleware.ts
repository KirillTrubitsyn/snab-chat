import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/app/lib/rate-limit";

// ── CSP configuration ──

const connectSrcParts = [
  "'self'",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  "https://*.up.railway.app",
];
const frameSrcParts = [
  "'self'",
  "https://*.up.railway.app",
  "https://disk.yandex.ru",
];

const backendUrl = process.env.NEXT_PUBLIC_API_URL || "";
if (backendUrl) {
  try {
    const origin = new URL(backendUrl).origin;
    if (!connectSrcParts.includes(origin)) connectSrcParts.push(origin);
    if (!frameSrcParts.includes(origin)) frameSrcParts.push(origin);
  } catch { /* invalid URL, skip */ }
}

function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array));
}

function buildCSP(nonce: string, pathname: string): string {
  // /api/sources/download and /help need to be embeddable in same-origin iframes
  const frameAncestors =
    pathname.startsWith("/api/sources/download") || pathname.startsWith("/help")
      ? "'self'"
      : "'none'";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrcParts.join(" ")}`,
    `frame-src ${frameSrcParts.join(" ")}`,
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

// ── Rate limiting ──

const RATE_LIMITS: Record<string, [number, number]> = {
  "/api/chat":       [20, 60_000],   // 20 req/min — LLM calls are expensive
  "/api/parse":      [15, 60_000],   // 15 req/min — file parsing
  "/api/ingest":     [15, 60_000],   // 15 req/min — indexing
  "/api/search":     [30, 60_000],   // 30 req/min — search
  "/api/kb-search":  [30, 60_000],   // 30 req/min — kb search
  "/api/infographic":[5,  60_000],   // 5 req/min — heavy LLM + image
  "/api/auth/login": [10, 60_000],   // 10 req/min — brute-force protection
  "/api/auth/login-password": [5, 60_000], // 5 req/min — password-only login (bcrypt-heavy)
  "/api/auth/verify-password": [10, 60_000], // 10 req/min — password check before 2FA
  "/api/auth/verify-otp": [8, 60_000], // 8 req/min — OTP brute-force reduction
  "/api/auth/verify-setup-otp": [6, 60_000], // 6 req/min — setup OTP brute-force reduction
  "/api/auth/register": [5, 60_000], // 5 req/min — registration
  "/api/support":    [10, 60_000],   // 10 req/min — support messages
};

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
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Generate per-request nonce for CSP
  const nonce = generateNonce();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  // ── API routes: rate limiting + origin validation ──
  if (pathname.startsWith("/api/")) {
    // Skip webhooks (Telegram sends retries if we reject)
    if (pathname.startsWith("/api/telegram/webhook")) {
      const response = NextResponse.next({ request: { headers: requestHeaders } });
      response.headers.set("Content-Security-Policy", buildCSP(nonce, pathname));
      return response;
    }

    // Block POST requests without valid Origin/Referer on sensitive endpoints
    if (req.method === "POST" && ORIGIN_PROTECTED_PATHS.some((p) => pathname.startsWith(p))) {
      const origin = req.headers.get("origin");
      const referer = req.headers.get("referer");
      const host = req.headers.get("host") || "";
      const hostWithoutPort = host.split(":")[0];
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

    // Rate limiting
    const ip = getClientIP(req);
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
      return NextResponse.json(
        { error: "Слишком много запросов. Попробуйте позже." },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        }
      );
    }
  }

  // ── Set CSP header with nonce and pass nonce to the app ──
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", buildCSP(nonce, pathname));
  return response;
}

export const config = {
  matcher: [
    // Match all routes except static assets
    "/((?!_next/static|_next/image|favicon\\.ico|icons/|manifest\\.json|sw\\.js).*)",
  ],
};
