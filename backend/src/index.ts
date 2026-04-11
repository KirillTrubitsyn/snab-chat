import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";

// Route imports
import healthRouter from "./routes/health.js";
import conversationsRouter from "./routes/conversations.js";
import authRouter from "./routes/auth.js";
import supportRouter from "./routes/support.js";
import errorsRouter from "./routes/errors.js";
import adminRouter from "./routes/admin.js";
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

// ── CORS ──
// FRONTEND_URLS supports multiple origins separated by comma
// e.g. "https://www.snabchat.app,https://snab-chat.vercel.app"
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
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

// Deduplicate
const uniqueOrigins = [...new Set(allowedOrigins)];
console.log(`[backend] Allowed CORS origins: ${JSON.stringify(uniqueOrigins)}`);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, health checks)
    if (!origin) return callback(null, true);
    // Exact match
    if (uniqueOrigins.includes(origin)) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  exposedHeaders: ["X-Sources", "X-Chunk-Images"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-invite-code", "x-admin-code", "x-device-id"],
}));

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
