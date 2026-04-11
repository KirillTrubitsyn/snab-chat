/**
 * Next.js Instrumentation — runs once at server startup (Node.js runtime).
 * Initializes shared Redis client for distributed rate limiting.
 */
export async function register() {
  // Only initialize Redis in the Node.js runtime (skip Edge runtime)
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("[instrumentation] REDIS_URL not set, rate limiting will use in-memory fallback");
    return;
  }

  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy(times: number) {
        if (times > 5) return null;
        return Math.min(times * 500, 3000);
      },
    });

    client.on("error", (err) => {
      console.error("[redis] Connection error:", err.message);
    });

    client.on("connect", () => {
      console.log("[redis] Connected successfully");
    });

    (globalThis as any).__redis = client;
  } catch (err) {
    console.warn("[instrumentation] Failed to initialize Redis:", err);
  }
}
