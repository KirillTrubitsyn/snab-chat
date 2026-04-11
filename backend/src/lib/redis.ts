import Redis from "ioredis";

let client: Redis | null = null;

export function getRedis(): Redis | null {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("[redis] REDIS_URL not set, rate limiting will use in-memory fallback");
    return null;
  }

  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy(times) {
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

    return client;
  } catch (err) {
    console.warn("[redis] Failed to create client:", err);
    return null;
  }
}
