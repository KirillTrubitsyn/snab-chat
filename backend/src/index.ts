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

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ── Security ──
app.use(helmet());

// ── CORS ──
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
// Support both www and non-www origins, and Vercel preview deployments
const allowedOrigins: string[] = [FRONTEND_URL];
if (FRONTEND_URL.includes("://www.")) {
  allowedOrigins.push(FRONTEND_URL.replace("://www.", "://"));
} else if (FRONTEND_URL.match(/^https?:\/\/[^/]+/)) {
  allowedOrigins.push(FRONTEND_URL.replace("://", "://www."));
}
// Also allow Vercel preview deployments if the frontend is on Vercel
if (FRONTEND_URL.includes(".vercel.app")) {
  const projectName = FRONTEND_URL.match(/https?:\/\/([^.]+)/)?.[1];
  if (projectName) {
    // Preview URLs: project-name-{hash}-username.vercel.app
    allowedOrigins.push(`https://${projectName}-*.vercel.app`);
  }
}
console.log(`[backend] Allowed CORS origins: ${JSON.stringify(allowedOrigins)}`);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, health checks)
    if (!origin) return callback(null, true);
    // Exact match
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Wildcard match for Vercel preview deployments
    for (const pattern of allowedOrigins) {
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        if (regex.test(origin)) return callback(null, true);
      }
    }
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  exposedHeaders: ["X-Sources", "X-Chunk-Images"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-invite-code", "x-admin-code"],
}));

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

// ── Error handling ──
app.use(errorHandler);

// ── Start server ──
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[backend] Server running on port ${PORT}`);
  console.log(`[backend] CORS origin: ${FRONTEND_URL}`);
  console.log(`[backend] Health check: http://localhost:${PORT}/health`);
});

export default app;
