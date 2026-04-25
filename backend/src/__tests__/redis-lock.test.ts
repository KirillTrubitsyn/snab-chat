/**
 * Tests for the generic Redis advisory lock used by:
 *   - summarization-lock.ts (MEDIUM-5);
 *   - auth.ts checkAndRegisterDevice (MEDIUM-4).
 *
 * Uses an in-memory FakeRedis honoring SET NX EX semantics and the
 * compare-and-delete Lua pattern release relies on.
 */

import { describe, it, expect } from "vitest";
import { acquireLock, releaseLock, NO_REDIS_TOKEN } from "../lib/redis-lock.js";

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
    if (!/GET/.test(script) || !/DEL/.test(script)) return 0;
    const e = this.store.get(key);
    if (!e || e.expiresAt < Date.now()) return 0;
    if (e.value !== expectedValue) return 0;
    this.store.delete(key);
    return 1;
  }

  _peek(key: string): string | null {
    const e = this.store.get(key);
    if (!e || e.expiresAt < Date.now()) return null;
    return e.value;
  }
}

describe("redis-lock — basic semantics", () => {
  it("acquires on first call with a unique token", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const tok = await acquireLock(redis, "x", 10);
    expect(tok).toBeTruthy();
    expect(tok).not.toBe(NO_REDIS_TOKEN);
  });

  it("returns null on second concurrent acquire of the same key", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const a = await acquireLock(redis, "x", 10);
    const b = await acquireLock(redis, "x", 10);
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it("acquires independently across different keys", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const a = await acquireLock(redis, "device-register:inv-1", 10);
    const b = await acquireLock(redis, "device-register:inv-2", 10);
    const c = await acquireLock(redis, "summary-lock:conv-1", 10);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(c).toBeTruthy();
  });

  it("returns NO_REDIS_TOKEN sentinel when redis is null", async () => {
    expect(await acquireLock(null, "x", 10)).toBe(NO_REDIS_TOKEN);
  });

  it("returns null on acquire when underlying redis throws", async () => {
    const broken = {
      async set() {
        throw new Error("offline");
      },
    } as unknown as import("ioredis").default;
    expect(await acquireLock(broken, "x", 10)).toBeNull();
  });
});

describe("redis-lock — compare-and-delete release", () => {
  it("releases when called with the matching token", async () => {
    const redis = new FakeRedis();
    const r = redis as unknown as import("ioredis").default;
    const tok = await acquireLock(r, "x", 10);
    expect(redis._peek("x")).toBe(tok);
    await releaseLock(r, "x", tok!);
    expect(redis._peek("x")).toBeNull();
  });

  it("does NOT release a lock owned by a different token", async () => {
    const redis = new FakeRedis();
    const r = redis as unknown as import("ioredis").default;
    const tok = await acquireLock(r, "x", 10);
    await releaseLock(r, "x", "wrong-token");
    expect(redis._peek("x")).toBe(tok);
  });

  it("is a no-op for NO_REDIS_TOKEN", async () => {
    await expect(releaseLock(null, "x", NO_REDIS_TOKEN)).resolves.toBeUndefined();
  });
});

describe("redis-lock — concurrent simulation (MEDIUM-4 + MEDIUM-5 core)", () => {
  it("under concurrent acquire only one caller wins", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const tries = await Promise.all(
      Array.from({ length: 5 }, () => acquireLock(redis, "race-key", 10))
    );
    const winners = tries.filter((t) => t && t !== NO_REDIS_TOKEN);
    expect(winners.length).toBe(1);
  });

  it("after release the next caller can acquire", async () => {
    const redis = new FakeRedis() as unknown as import("ioredis").default;
    const t1 = await acquireLock(redis, "k", 10);
    const t2 = await acquireLock(redis, "k", 10);
    expect(t2).toBeNull();
    await releaseLock(redis, "k", t1!);
    const t3 = await acquireLock(redis, "k", 10);
    expect(t3).toBeTruthy();
  });
});
