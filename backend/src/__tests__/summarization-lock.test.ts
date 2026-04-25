/**
 * Tests for summarization-lock — guards audit 24.04.2026 MEDIUM-5 fix.
 *
 * Uses an in-memory fake Redis that supports the SET NX EX path and the
 * compare-and-delete Lua script the production code relies on.
 */

import { describe, it, expect } from "vitest";
import {
  acquireLock,
  releaseLock,
  NO_REDIS_TOKEN,
} from "../lib/summarization-lock.js";

/** Minimal in-memory ioredis-shaped stub. */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<"OK" | null> {
    const flags = args.map((a) => String(a).toUpperCase());
    const nx = flags.includes("NX");
    const exIdx = flags.indexOf("EX");
    const ttlSec = exIdx >= 0 ? Number(args[exIdx + 1]) : 0;

    if (nx) {
      const e = this.store.get(key);
      if (e && e.expiresAt > Date.now()) return null;
    }
    this.store.set(key, {
      value,
      expiresAt: ttlSec > 0 ? Date.now() + ttlSec * 1000 : Number.MAX_SAFE_INTEGER,
    });
    return "OK";
  }

  async eval(
    script: string,
    _numKeys: number,
    key: string,
    expectedValue: string
  ): Promise<number> {
    // Recognize the compare-and-delete pattern used by releaseLock.
    if (!/GET/.test(script) || !/DEL/.test(script)) return 0;
    const e = this.store.get(key);
    if (!e || e.expiresAt < Date.now()) return 0;
    if (e.value !== expectedValue) return 0;
    this.store.delete(key);
    return 1;
  }

  /** Test helper. */
  _peek(key: string) {
    const e = this.store.get(key);
    if (!e || e.expiresAt < Date.now()) return null;
    return e.value;
  }
}

describe("acquireLock — basic semantics", () => {
  it("returns a token on first acquire", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const tok = await acquireLock(redis, "conv-1");
    expect(tok).toBeTruthy();
    expect(tok).not.toBe(NO_REDIS_TOKEN);
  });

  it("returns null on a second concurrent acquire (single-flight, MEDIUM-5 core)", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const tok1 = await acquireLock(redis, "conv-1");
    const tok2 = await acquireLock(redis, "conv-1");
    expect(tok1).toBeTruthy();
    expect(tok2).toBeNull();
  });

  it("allows different conversations to acquire independently", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const a = await acquireLock(redis, "conv-A");
    const b = await acquireLock(redis, "conv-B");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("returns NO_REDIS_TOKEN when redis is null (single-instance fallback)", async () => {
    const tok = await acquireLock(null, "conv-1");
    expect(tok).toBe(NO_REDIS_TOKEN);
  });
});

describe("releaseLock — compare-and-delete", () => {
  it("releases the lock when called with the matching token", async () => {
    const redis = new FakeRedis();
    const r = redis as unknown as import("ioredis").default;
    const tok = await acquireLock(r, "conv-1");
    expect(tok).toBeTruthy();
    expect(redis._peek("summary-lock:conv-1")).toBe(tok);
    await releaseLock(r, "conv-1", tok!);
    expect(redis._peek("summary-lock:conv-1")).toBeNull();
  });

  it("does NOT release a lock owned by a different token", async () => {
    const redis = new FakeRedis();
    const r = redis as unknown as import("ioredis").default;
    const tok = await acquireLock(r, "conv-1");
    // Worker B tries to release with a forged token after worker A's lock expired
    // and worker B got the lock. Compare-and-delete must reject.
    await releaseLock(r, "conv-1", "wrong-token");
    expect(redis._peek("summary-lock:conv-1")).toBe(tok);
  });

  it("is a no-op when token is NO_REDIS_TOKEN", async () => {
    // Should not throw, even with a real-shaped redis client.
    await expect(releaseLock(null, "conv-1", NO_REDIS_TOKEN)).resolves.toBeUndefined();
  });
});

describe("acquireLock — failure modes", () => {
  it("returns null if the underlying redis throws", async () => {
    const broken = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async set(): Promise<"OK" | null> {
        throw new Error("redis offline");
      },
    } as unknown as import("ioredis").default;
    const tok = await acquireLock(broken, "conv-1");
    expect(tok).toBeNull();
  });
});

describe("end-to-end: simulate two concurrent chat requests on the same conversation", () => {
  it("only one request gets the lock; the loser skips silently", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const conv = "long-running-chat";
    const [a, b] = await Promise.all([
      acquireLock(redis, conv),
      acquireLock(redis, conv),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners.length).toBe(1);
    // Winner releases; subsequent acquire should now succeed.
    await releaseLock(redis, conv, winners[0] as string);
    const c = await acquireLock(redis, conv);
    expect(c).toBeTruthy();
  });
});
