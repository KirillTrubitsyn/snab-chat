import { Router } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { embedQuery } from "../lib/embeddings.js";
import { getRedis } from "../lib/redis.js";

const router = Router();

const CHECK_TIMEOUT_MS = 3000;

type CheckStatus = "ok" | "fail" | "skipped";
interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
  error?: string;
}

/** Wrap a check with a 3s timeout; returns "fail" on timeout or rejection. */
async function timedCheck(
  name: string,
  fn: () => Promise<unknown>,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`${name} timeout ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS),
      ),
    ]);
    return { status: "ok", latencyMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "fail",
      latencyMs: Date.now() - started,
      // Keep error text short; avoid leaking infrastructure details.
      error: message.slice(0, 160),
    };
  }
}

async function checkSupabase(): Promise<CheckResult> {
  return timedCheck("supabase", async () => {
    const supabase = createServiceClient();
    // Lightweight round-trip: SELECT 1 via sources table head count.
    const { error } = await supabase
      .from("sources")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) throw new Error(error.message);
  });
}

async function checkGemini(): Promise<CheckResult> {
  return timedCheck("gemini", async () => {
    // Minimal 2-char query; stays inside free/low-cost tier.
    const vec = await embedQuery("ok");
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error("empty embedding");
    }
  });
}

async function checkRedis(): Promise<CheckResult> {
  // Redis is optional — if not configured, report as skipped (not a failure).
  if (!process.env.REDIS_URL) {
    return { status: "skipped", latencyMs: 0 };
  }
  return timedCheck("redis", async () => {
    const client = getRedis();
    if (!client) throw new Error("redis client unavailable");
    const pong = await client.ping();
    if (pong !== "PONG") throw new Error(`unexpected ping reply: ${pong}`);
  });
}

/**
 * Basic health check.
 *
 * - /health         → real checks of Supabase + Gemini + Redis (if configured).
 *                     503 if any required check fails; 200 with full breakdown otherwise.
 * - /health?shallow → skip LLM/DB checks (liveness-only, always 200 unless process dead).
 *
 * Each external check has a 3s timeout. Errors are summarised — no internals are
 * leaked to the client.
 */
router.get("/health", async (req, res) => {
  const shallow = req.query.shallow === "true" || req.query.shallow === "1";
  if (shallow) {
    return res.json({ status: "ok", mode: "shallow", v: "graph-preseed-v1" });
  }

  const [supabase, gemini, redis] = await Promise.all([
    checkSupabase(),
    checkGemini(),
    checkRedis(),
  ]);

  const unhealthy =
    supabase.status === "fail" ||
    gemini.status === "fail" ||
    redis.status === "fail";

  const body = {
    status: unhealthy ? "unhealthy" : "ok",
    v: "graph-preseed-v1",
    checks: { supabase, gemini, redis },
  };

  return res.status(unhealthy ? 503 : 200).json(body);
});

export default router;
