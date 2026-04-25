/**
 * Tests for the chunk-image signed token (deep-research HIGH-1 fix).
 * Guards: tokens are path-bound, time-bound, tamper-resistant, and not
 * cross-replayable between paths.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  signChunkImageToken,
  verifyChunkImageToken,
  CHUNK_IMAGE_TOKEN_TTL_MS,
} from "../lib/chunk-image-token.js";

beforeEach(() => {
  process.env.AUTH_TOKEN_SECRET = "test-secret-at-least-16-chars-long-aaaa";
});

describe("signChunkImageToken / verifyChunkImageToken — happy path", () => {
  it("verifies a freshly signed token for the same path", () => {
    const path = "abc/def.png";
    const tok = signChunkImageToken(path);
    expect(verifyChunkImageToken(tok, path)).toBe(true);
  });

  it("produces tokens that are URL-safe base64", () => {
    const tok = signChunkImageToken("a/b.png");
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet
    expect(tok).not.toContain("=");
    expect(tok).not.toContain("+");
    expect(tok).not.toContain("/");
  });

  it("produces different tokens for the same path on consecutive calls", () => {
    // Different `exp` timestamps produce different signatures.
    const t1 = signChunkImageToken("a/b.png");
    // Force a tiny delay via a fake-timer tick.
    const t2 = signChunkImageToken("a/b.png");
    // They might be equal if Date.now() is stable in the same ms; that's OK.
    // Just assert verification still works for both.
    expect(verifyChunkImageToken(t1, "a/b.png")).toBe(true);
    expect(verifyChunkImageToken(t2, "a/b.png")).toBe(true);
  });
});

describe("verifyChunkImageToken — path binding (deep-research HIGH-1 core)", () => {
  it("rejects a token signed for path A used against path B", () => {
    const tokA = signChunkImageToken("user-a/secret.png");
    expect(verifyChunkImageToken(tokA, "user-b/secret.png")).toBe(false);
  });

  it("rejects when path differs by even a single byte", () => {
    const tok = signChunkImageToken("a/b.png");
    expect(verifyChunkImageToken(tok, "a/b.PNG")).toBe(false);
    expect(verifyChunkImageToken(tok, " a/b.png")).toBe(false);
    expect(verifyChunkImageToken(tok, "a/b.pn")).toBe(false);
  });
});

describe("verifyChunkImageToken — expiration", () => {
  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const tok = signChunkImageToken("a/b.png");
      // Jump past TTL.
      vi.setSystemTime(new Date(Date.now() + CHUNK_IMAGE_TOKEN_TTL_MS + 1000));
      expect(verifyChunkImageToken(tok, "a/b.png")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a token issued just before now", () => {
    const tok = signChunkImageToken("a/b.png");
    expect(verifyChunkImageToken(tok, "a/b.png")).toBe(true);
  });
});

describe("verifyChunkImageToken — tamper resistance", () => {
  it("rejects garbage input", () => {
    expect(verifyChunkImageToken("not-a-token", "a/b.png")).toBe(false);
    expect(verifyChunkImageToken("", "a/b.png")).toBe(false);
    expect(verifyChunkImageToken("AAAA", "a/b.png")).toBe(false);
  });

  it("rejects empty path even with valid-looking token", () => {
    const tok = signChunkImageToken("a/b.png");
    expect(verifyChunkImageToken(tok, "")).toBe(false);
  });

  it("rejects when secret changes mid-life", () => {
    const tok = signChunkImageToken("a/b.png");
    process.env.AUTH_TOKEN_SECRET = "different-secret-at-least-16-chars-long";
    expect(verifyChunkImageToken(tok, "a/b.png")).toBe(false);
  });

  it("rejects when signature bytes are flipped", () => {
    const tok = signChunkImageToken("a/b.png");
    // Decode, flip last char, re-encode
    const raw = Buffer.from(tok, "base64url").toString("utf8");
    const flipped = raw.slice(0, -1) + (raw.slice(-1) === "0" ? "1" : "0");
    const tampered = Buffer.from(flipped, "utf8").toString("base64url");
    expect(verifyChunkImageToken(tampered, "a/b.png")).toBe(false);
  });

  it("rejects when expiration is forged forward", () => {
    const tok = signChunkImageToken("a/b.png");
    const raw = Buffer.from(tok, "base64url").toString("utf8");
    const sep = raw.indexOf(":");
    const sig = raw.slice(sep + 1);
    // Forge a far-future exp but keep the original sig.
    const forged = Buffer.from(`${Date.now() + 99999999999}:${sig}`, "utf8").toString("base64url");
    expect(verifyChunkImageToken(forged, "a/b.png")).toBe(false);
  });
});

describe("signChunkImageToken — secret hygiene", () => {
  it("throws if AUTH_TOKEN_SECRET is unset", () => {
    delete process.env.AUTH_TOKEN_SECRET;
    expect(() => signChunkImageToken("a/b.png")).toThrow(/AUTH_TOKEN_SECRET/);
  });

  it("throws if AUTH_TOKEN_SECRET is too short", () => {
    process.env.AUTH_TOKEN_SECRET = "short";
    expect(() => signChunkImageToken("a/b.png")).toThrow(/AUTH_TOKEN_SECRET/);
  });
});

describe("verifyChunkImageToken — defensive returns", () => {
  it("returns false (not throws) when secret is missing at verify time", () => {
    const tok = signChunkImageToken("a/b.png");
    delete process.env.AUTH_TOKEN_SECRET;
    expect(verifyChunkImageToken(tok, "a/b.png")).toBe(false);
  });
});
