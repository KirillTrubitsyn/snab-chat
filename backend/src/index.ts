import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";
import { isValidServiceAuthFromHeaders } from "./lib/service-auth.js";

// Route imports
import healthRouter from "./routes/health.js";
import conversationsRouter from "./routes/conversations.js";
import authRouter from "./routes/auth.js";
import supportRouter from "./routes/support.js";
import errorsRouter from "./routes/errors.js";
import adminRouter from "./routes/admin.js";
import adminAnalyticsRouter from "./routes/admin-analytics.js";
import adminRagRouter from "./routes/admin-rag.js";
import adminExtractEntitiesRouter from "./routes/admin-extract-entities.js";
import sourcesRouter from "./routes/sources.js";
import searchRouter from "./routes/search.js";
import uploadRouter from "./routes/upload.js";
import parseRouter from "./routes/parse.js";
import ingestRouter from "./routes/ingest.js";
import exportRouter from "./routes/export.js";
import infographicRouter from "./routes/infographic.js";
import infographicsRouter from "./routes/infographics.js";
import fetchUrlRouter from "./routes/fetch-url.js";
import telegramRouter from "./routes/telegram.js";
import miscRouter from "./routes/misc.js";
import chatRouter from "./routes/chat.js";
import heartbeatRouter from "./routes/heartbeat.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ── Security ──
app.use(helmet());
// N10 fix: HSTS header for HTTPS enforcement
app.use((_req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

// ── CORS ──
// FRONTEND_URLS supports multiple origins separated by comma
// e.g. "https://www.snabchat.app,https://snab-chat.vercel.app"
const FRONTEND_URL_RAW = process.env.FRONTEND_URL || "";
if (!FRONTEND_URL_RAW && process.env.NODE_ENV === "production") {
  console.error("[FATAL] FRONTEND_URL is not set in production — CORS will reject all browser requests");
}
const FRONTEND_URL = (FRONTEND_URL_RAW || "http://localhost:3000").replace(/\/+$/, "");
const allowedOrigins: string[] = [];

for (const raw of FRONTEND_URL.split(",")) {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) continue;
  allowedOrigins.push(url);
  // Auto-add www / non-www variant
  if (url.includes("://www.")) {
    allowedOrigins.push(url.replace("://www.", "://"));
  } else if (url.match(/^https?:\/\/[^/]+/)) {
    allowedOrigins.push(url.replace("://", "://www."));
  }
}

// Deduplicate and strip localhost in production
const uniqueOrigins = [...new Set(allowedOrigins)].filter((o) => {
  if (process.env.NODE_ENV === "production" && /localhost|127\.0\.0\.1/.test(o)) {
    console.warn(`[CORS] Stripping localhost origin in production: ${o}`);
    return false;
  }
  return true;
});
console.log(`[backend] Allowed CORS origins: ${JSON.stringify(uniqueOrigins)}`);

app.use(cors({
  origin: (origin, callback) => {
    // Allow health check and webhook (no browser origin)
    if (!origin) {
      // Non-browser requests (curl, server-to-server) — allow but origin validation
      // middleware below will block mutations without valid Origin header
      return callback(null, true);
    }
    // Exact match against allowed frontend origins
    if (uniqueOrigins.includes(origin)) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error("CORS"));
  },
  credentials: true,
  exposedHeaders: ["X-Sources", "X-Chunk-Images"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-invite-code", "x-admin-code", "x-device-id", "x-auth-token", "x-api-key", "x-admin-session"],
}));

// ── Service-auth path exception (для межсервисных вызовов без браузерного Origin) ──
// Точечное исключение из Origin-middleware для ДВУХ путей:
//   - /api/chat                         — чат-вызов из скриптов/тестов
//   - /api/admin/extract-entities       — извлечение сущностей в граф
//
// Для обоих путей требуется (см. backend/src/lib/service-auth.ts):
//   1. EXTRACTION_SERVICE_KEY задан в ENV, длина ≥ 32.
//   2. x-api-key совпадает с ним (timing-safe).
//   3. x-admin-code принадлежит сервис-аккаунту (admin_number === 4).
//
// Живые админы (1, 2) service-путь использовать не могут — они ходят
// через браузер с 2FA-сессией. Это жёсткое разделение прав:
// сервис-ключ → только admin 4 → только два эндпоинта.
//
// Все остальные слои защиты (admin-code проверка, audit-log, rate-limit)
// остаются в силе — они прогоняются внутри роутов.
const SERVICE_AUTH_PATHS = new Set<string>([
  "/api/chat",
  "/api/admin/extract-entities",
  "/api/admin/embed-null-entities",
]);

// ── Origin validation for mutation requests ──
// Block POST/PATCH/DELETE without a valid Origin header (prevents curl/Postman/scripts)
const ORIGIN_EXEMPT_PATHS = ["/health", "/api/telegram/webhook"];
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "OPTIONS" || req.method === "HEAD") {
    return next();
  }
  const path = req.path;
  if (ORIGIN_EXEMPT_PATHS.some((p) => path.startsWith(p))) {
    return next();
  }

  // Service-auth exception: только для разрешённых путей и только при
  // валидных ключе + коде admin 4. Любая частичная проверка → fallthrough
  // на обычную Origin-проверку, как если бы ключа не было.
  if (SERVICE_AUTH_PATHS.has(path) && isValidServiceAuthFromHeaders(req)) {
    console.log(`[Origin] Service-auth bypass for ${req.method} ${path}`);
    return next();
  }

  const origin = req.headers.origin;
  if (!origin) {
    console.warn(`[Origin] Blocked no-origin ${req.method} ${path} from ${req.ip}`);
    return res.status(403).json({ error: "Запрос отклонён: отсутствует Origin" });
  }
  if (!uniqueOrigins.includes(origin)) {
    console.warn(`[Origin] Blocked invalid origin ${origin} for ${req.method} ${path}`);
    return res.status(403).json({ error: "Запрос отклонён: недопустимый Origin" });
  }
  next();
});

// ── API key validation ──
// Optional shared secret between frontend and backend. When BACKEND_API_KEY is set,
// all API requests (except /health and webhook) must include x-api-key header.
// This prevents direct API access even if the backend URL leaks.
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || "";
// Service-auth пути исключены, потому что они используют собственный,
// более строгий EXTRACTION_SERVICE_KEY через isValidServiceAuthFromHeaders
// и route-level проверки. BACKEND_API_KEY был бы слабее (плоский shared
// secret без привязки к admin_number).
const API_KEY_EXEMPT_PATHS = [
  "/health",
  "/api/telegram/webhook",
  ...SERVICE_AUTH_PATHS,
];
if (BACKEND_API_KEY) {
  app.use((req, res, next) => {
    if (API_KEY_EXEMPT_PATHS.some((p) => req.path.startsWith(p))) return next();
    const clientKey = req.headers["x-api-key"] as string;
    if (clientKey !== BACKEND_API_KEY) {
      console.warn(`[API-Key] Rejected ${req.method} ${req.path} — invalid or missing key`);
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  });
  console.log("[backend] API key validation enabled");
}

// ── Body parsing ──
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── Rate limiting ──
app.use(rateLimitMiddleware);

// ── Routes ──
app.use(healthRouter);
app.use(conversationsRouter);
app.use(authRouter);
app.use(supportRouter);
app.use(errorsRouter);
app.use(adminRouter);
app.use(adminAnalyticsRouter);
app.use(adminRagRouter);
app.use(adminExtractEntitiesRouter);
app.use(sourcesRouter);
app.use(searchRouter);
app.use(uploadRouter);
app.use(parseRouter);
app.use(ingestRouter);
app.use(exportRouter);
app.use(infographicRouter);
app.use(infographicsRouter);
app.use(fetchUrlRouter);
app.use(telegramRouter);
app.use(miscRouter);
app.use(chatRouter);
app.use(heartbeatRouter);

// ── Error handling ──
app.use(errorHandler);

// ── Start server ──
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[backend] Server running on port ${PORT}`);
  console.log(`[backend] CORS origin: ${FRONTEND_URL}`);
  console.log(`[backend] Health check: http://localhost:${PORT}/health`);
});

export default app;
