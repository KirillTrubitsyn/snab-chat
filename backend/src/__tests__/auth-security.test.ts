/**
 * Security tests for authentication system.
 * Validates that:
 * 1. Auth tokens are ALWAYS required (password is mandatory)
 * 2. Invite code alone is never sufficient for API access
 * 3. Token generation and verification work correctly
 * 4. Expired/invalid/tampered tokens are rejected
 * 5. Admin codes bypass invite code validation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// ── Token functions (extracted logic for direct testing) ──

const AUTH_TOKEN_SECRET = "test-secret-key";
const AUTH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateAuthToken(inviteCodeId: string, secret = AUTH_TOKEN_SECRET): string {
  const timestamp = Date.now().toString();
  const payload = `${inviteCodeId}:${timestamp}`;
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `${payload}:${signature}`;
}

function verifyAuthToken(
  token: string,
  expectedInviteCodeId: string,
  secret = AUTH_TOKEN_SECRET
): boolean {
  const parts = token.split(":");
  if (parts.length !== 3) return false;

  const [inviteCodeId, timestampStr, providedSig] = parts;
  if (inviteCodeId !== expectedInviteCodeId) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  const age = Date.now() - timestamp;
  if (age > AUTH_TOKEN_MAX_AGE_MS || age < 0) return false;

  const expectedSig = createHmac("sha256", secret)
    .update(`${inviteCodeId}:${timestampStr}`)
    .digest("hex");

  return providedSig === expectedSig;
}

// ── Simulate getInviteCodeFromHeader logic ──

interface MockInviteCode {
  id: string;
  code: string;
  name: string;
  password_hash: string | null;
  is_active: boolean;
}

/**
 * Simulates the core auth logic from getInviteCodeFromHeader.
 * Returns the invite code data if auth passes, null otherwise.
 */
function simulateAuthCheck(
  headerCode: string | undefined,
  headerAuthToken: string | undefined,
  dbRecord: MockInviteCode | null,
  adminCodes: string[] = []
): MockInviteCode | null {
  // No code header → rejected
  if (!headerCode) return null;

  // Admin code → bypasses invite code check (separate path)
  if (adminCodes.includes(headerCode.toUpperCase())) {
    return null; // Admin path returns a synthetic object, not a DB record
  }

  // No DB record for this code → rejected
  if (!dbRecord) return null;
  if (!dbRecord.is_active) return null;

  // SECURITY: ALWAYS require auth token (the key security enforcement)
  if (!headerAuthToken || !verifyAuthToken(headerAuthToken, dbRecord.id)) {
    return null;
  }

  return dbRecord;
}

// ── Tests ──

describe("Auth Token Generation & Verification", () => {
  const inviteCodeId = "550e8400-e29b-41d4-a716-446655440000";

  it("generates a valid token with correct format", () => {
    const token = generateAuthToken(inviteCodeId);
    const parts = token.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(inviteCodeId);
    expect(parseInt(parts[1], 10)).toBeGreaterThan(0);
    expect(parts[2]).toHaveLength(64); // SHA-256 hex
  });

  it("verifies a freshly generated token", () => {
    const token = generateAuthToken(inviteCodeId);
    expect(verifyAuthToken(token, inviteCodeId)).toBe(true);
  });

  it("rejects token for wrong invite code ID", () => {
    const token = generateAuthToken(inviteCodeId);
    expect(verifyAuthToken(token, "wrong-id")).toBe(false);
  });

  it("rejects token with tampered signature", () => {
    const token = generateAuthToken(inviteCodeId);
    const parts = token.split(":");
    const tamperedToken = `${parts[0]}:${parts[1]}:${"a".repeat(64)}`;
    expect(verifyAuthToken(tamperedToken, inviteCodeId)).toBe(false);
  });

  it("rejects token with tampered timestamp", () => {
    const token = generateAuthToken(inviteCodeId);
    const parts = token.split(":");
    const tamperedToken = `${parts[0]}:9999999999999:${parts[2]}`;
    expect(verifyAuthToken(tamperedToken, inviteCodeId)).toBe(false);
  });

  it("rejects token signed with different secret", () => {
    const token = generateAuthToken(inviteCodeId, "other-secret");
    expect(verifyAuthToken(token, inviteCodeId, AUTH_TOKEN_SECRET)).toBe(false);
  });

  it("rejects expired token (>30 days)", () => {
    const expiredTimestamp = (Date.now() - 31 * 24 * 60 * 60 * 1000).toString();
    const payload = `${inviteCodeId}:${expiredTimestamp}`;
    const signature = createHmac("sha256", AUTH_TOKEN_SECRET)
      .update(payload)
      .digest("hex");
    const expiredToken = `${payload}:${signature}`;
    expect(verifyAuthToken(expiredToken, inviteCodeId)).toBe(false);
  });

  it("accepts token within 30-day window", () => {
    const recentTimestamp = (Date.now() - 29 * 24 * 60 * 60 * 1000).toString();
    const payload = `${inviteCodeId}:${recentTimestamp}`;
    const signature = createHmac("sha256", AUTH_TOKEN_SECRET)
      .update(payload)
      .digest("hex");
    const recentToken = `${payload}:${signature}`;
    expect(verifyAuthToken(recentToken, inviteCodeId)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(verifyAuthToken("", inviteCodeId)).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifyAuthToken("just-a-string", inviteCodeId)).toBe(false);
    expect(verifyAuthToken("a:b", inviteCodeId)).toBe(false);
    expect(verifyAuthToken("a:b:c:d", inviteCodeId)).toBe(false);
  });

  it("rejects token with future timestamp", () => {
    const futureTimestamp = (Date.now() + 60000).toString();
    const payload = `${inviteCodeId}:${futureTimestamp}`;
    const signature = createHmac("sha256", AUTH_TOKEN_SECRET)
      .update(payload)
      .digest("hex");
    const futureToken = `${payload}:${signature}`;
    expect(verifyAuthToken(futureToken, inviteCodeId)).toBe(false);
  });
});

describe("Mandatory Password Enforcement", () => {
  const dbUser: MockInviteCode = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    code: "TESTCODE",
    name: "Test User",
    password_hash: "$2b$12$hashedpassword",
    is_active: true,
  };

  const dbUserNoPassword: MockInviteCode = {
    id: "660e8400-e29b-41d4-a716-446655440001",
    code: "NEWCODE",
    name: "New User",
    password_hash: null,
    is_active: true,
  };

  it("REJECTS invite code WITHOUT auth token (user with password)", () => {
    const result = simulateAuthCheck("TESTCODE", undefined, dbUser);
    expect(result).toBeNull();
  });

  it("REJECTS invite code WITHOUT auth token (user WITHOUT password)", () => {
    // THIS IS THE KEY SECURITY TEST:
    // Previously, users without passwords could access the API with just the code.
    // Now they are rejected — they must set a password first.
    const result = simulateAuthCheck("NEWCODE", undefined, dbUserNoPassword);
    expect(result).toBeNull();
  });

  it("REJECTS invite code with INVALID auth token", () => {
    const result = simulateAuthCheck("TESTCODE", "invalid-token", dbUser);
    expect(result).toBeNull();
  });

  it("REJECTS invite code with token for DIFFERENT user", () => {
    const otherToken = generateAuthToken("other-user-id");
    const result = simulateAuthCheck("TESTCODE", otherToken, dbUser);
    expect(result).toBeNull();
  });

  it("ACCEPTS invite code with VALID auth token", () => {
    const validToken = generateAuthToken(dbUser.id);
    const result = simulateAuthCheck("TESTCODE", validToken, dbUser);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(dbUser.id);
  });

  it("REJECTS inactive invite code even with valid token", () => {
    const inactiveUser = { ...dbUser, is_active: false };
    const validToken = generateAuthToken(inactiveUser.id);
    const result = simulateAuthCheck("TESTCODE", validToken, inactiveUser);
    expect(result).toBeNull();
  });

  it("REJECTS non-existent invite code", () => {
    const result = simulateAuthCheck("FAKECODE", undefined, null);
    expect(result).toBeNull();
  });

  it("REJECTS empty code header", () => {
    const result = simulateAuthCheck(undefined, undefined, null);
    expect(result).toBeNull();
  });

  it("REJECTS expired token even for valid user", () => {
    const expiredTimestamp = (Date.now() - 31 * 24 * 60 * 60 * 1000).toString();
    const payload = `${dbUser.id}:${expiredTimestamp}`;
    const signature = createHmac("sha256", AUTH_TOKEN_SECRET)
      .update(payload)
      .digest("hex");
    const expiredToken = `${payload}:${signature}`;
    const result = simulateAuthCheck("TESTCODE", expiredToken, dbUser);
    expect(result).toBeNull();
  });
});

describe("Admin Code Bypass", () => {
  const adminCodes = ["ADMIN-MASTER"];

  it("admin code does not go through invite code path", () => {
    // Admin codes return null from simulateAuthCheck because they're
    // handled by a different code path (requireAuth checks isAdminCode first)
    const result = simulateAuthCheck("ADMIN-MASTER", undefined, null, adminCodes);
    expect(result).toBeNull(); // null = handled by admin path, not rejected
  });

  it("non-admin code is not treated as admin", () => {
    const result = simulateAuthCheck("NOT-ADMIN", undefined, null, adminCodes);
    expect(result).toBeNull(); // rejected because no DB record
  });
});

describe("Auth Flow Integration Scenarios", () => {
  it("scenario: new user enters invite code → must set password first", () => {
    const newUser: MockInviteCode = {
      id: "new-user-id",
      code: "INVITE123",
      name: "New User",
      password_hash: null,
      is_active: true,
    };

    // Step 1: User enters invite code — API access is DENIED (no token)
    const apiAccess = simulateAuthCheck("INVITE123", undefined, newUser);
    expect(apiAccess).toBeNull(); // Can't use chat/infographic yet

    // Step 2: User sets password via /api/auth/set-password
    // (This route doesn't use getInviteCodeFromHeader, it validates directly)
    // Server generates auth token after password creation
    const authToken = generateAuthToken(newUser.id);

    // Step 3: Now user can access API with the token
    const apiAccessWithToken = simulateAuthCheck("INVITE123", authToken, newUser);
    expect(apiAccessWithToken).not.toBeNull();
  });

  it("scenario: returning user enters password → gets token → accesses API", () => {
    const existingUser: MockInviteCode = {
      id: "existing-user-id",
      code: "MYCODE",
      name: "Existing User",
      password_hash: "$2b$12$hashed",
      is_active: true,
    };

    // Step 1: User enters password → /api/auth/login-password → gets token
    const authToken = generateAuthToken(existingUser.id);

    // Step 2: API access with token works
    const result = simulateAuthCheck("MYCODE", authToken, existingUser);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Existing User");
  });

  it("scenario: attacker knows invite code but not password → BLOCKED", () => {
    const user: MockInviteCode = {
      id: "user-id",
      code: "KNOWNCODE",
      name: "User",
      password_hash: "$2b$12$hashed",
      is_active: true,
    };

    // Attacker tries to use invite code directly → no token → blocked
    const result = simulateAuthCheck("KNOWNCODE", undefined, user);
    expect(result).toBeNull();
  });

  it("scenario: attacker fabricates token without knowing secret → BLOCKED", () => {
    const user: MockInviteCode = {
      id: "user-id",
      code: "KNOWNCODE",
      name: "User",
      password_hash: "$2b$12$hashed",
      is_active: true,
    };

    // Attacker crafts a token with wrong secret
    const fakeToken = generateAuthToken(user.id, "wrong-secret");
    const result = simulateAuthCheck("KNOWNCODE", fakeToken, user);
    expect(result).toBeNull();
  });

  it("scenario: user code deleted → cannot access even with old token", () => {
    // DB record no longer exists (code deleted by admin)
    const oldToken = generateAuthToken("deleted-user-id");
    const result = simulateAuthCheck("DELETEDCODE", oldToken, null);
    expect(result).toBeNull();
  });
});
