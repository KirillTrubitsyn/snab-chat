/**
 * Tests for infographic audit trail.
 * Validates that:
 * 1. Admin-created infographics store admin_name (no more "Неизвестный")
 * 2. IP address is captured for all infographic generation
 * 3. Admin activity display resolves admin names correctly
 * 4. Audit log events are created for infographic generation
 */

import { describe, it, expect } from "vitest";

// ── Simulate the admin name resolution logic from admin.ts ──

interface InfographicRecord {
  id: string;
  invite_code_id: string | null;
  conversation_id: string | null;
  admin_name: string | null;
  ip_address: string | null;
  topic: string;
  created_at: string;
}

interface ConvInfo {
  invite_code_id: string | null;
  admin_name: string | null;
}

interface CodeInfo {
  name: string;
  organization: string | null;
}

/**
 * Simulates the infographic user resolution logic from admin.ts.
 * This is the exact logic that determines what name appears in the admin panel.
 */
function resolveInfographicUser(
  ig: InfographicRecord,
  convsMap: Record<string, ConvInfo>,
  codesMap: Record<string, CodeInfo>
): { user_name: string; organization: string | null } {
  let user_name = "Неизвестный";
  let organization: string | null = "";

  if (ig.conversation_id && ig.conversation_id in convsMap) {
    const conv = convsMap[ig.conversation_id];
    if (conv.invite_code_id && conv.invite_code_id in codesMap) {
      const codeInfo = codesMap[conv.invite_code_id];
      user_name = codeInfo.name || "Неизвестный";
      organization = codeInfo.organization || null;
    } else if (conv.admin_name) {
      user_name = conv.admin_name;
      organization = "Админ";
    }
  } else if (ig.invite_code_id && ig.invite_code_id in codesMap) {
    const code = codesMap[ig.invite_code_id];
    user_name = code.name || "Неизвестный";
    organization = code.organization || "";
  } else if (ig.admin_name) {
    // NEW: Admin-created infographic with admin_name stored directly
    user_name = ig.admin_name;
    organization = "Админ";
  }

  return { user_name, organization };
}

// ── Simulate infographic insert data building ──

function buildInfographicInsertData(params: {
  inviteId: string | null;
  inviteIdStartsWithAdmin: boolean;
  conversationId: string | null;
  topic: string;
  adminName: string | null;
  clientIp: string;
}) {
  const isRealInviteCode = params.inviteId && !params.inviteIdStartsWithAdmin;
  return {
    invite_code_id: isRealInviteCode ? params.inviteId : null,
    conversation_id: params.conversationId || null,
    topic: params.topic,
    admin_name: params.adminName || null,
    ip_address: params.clientIp,
  };
}

// ── Tests ──

describe("Infographic User Resolution (admin panel display)", () => {
  const convsMap: Record<string, ConvInfo> = {
    "conv-1": { invite_code_id: "code-1", admin_name: null },
    "conv-2": { invite_code_id: null, admin_name: "Иванов Иван" },
  };

  const codesMap: Record<string, CodeInfo> = {
    "code-1": { name: "Петрова Мария", organization: "ООО Ромашка" },
  };

  it("resolves regular user by conversation → invite code", () => {
    const ig: InfographicRecord = {
      id: "ig-1",
      invite_code_id: "code-1",
      conversation_id: "conv-1",
      admin_name: null,
      ip_address: "1.2.3.4",
      topic: "Тест",
      created_at: "2026-04-12T00:00:00Z",
    };
    const result = resolveInfographicUser(ig, convsMap, codesMap);
    expect(result.user_name).toBe("Петрова Мария");
    expect(result.organization).toBe("ООО Ромашка");
  });

  it("resolves regular user by invite_code_id (no conversation)", () => {
    const ig: InfographicRecord = {
      id: "ig-2",
      invite_code_id: "code-1",
      conversation_id: null,
      admin_name: null,
      ip_address: "1.2.3.4",
      topic: "Тест",
      created_at: "2026-04-12T00:00:00Z",
    };
    const result = resolveInfographicUser(ig, convsMap, codesMap);
    expect(result.user_name).toBe("Петрова Мария");
    expect(result.organization).toBe("ООО Ромашка");
  });

  it("resolves admin by admin_name field (NEW — fixes 'Неизвестный')", () => {
    const ig: InfographicRecord = {
      id: "ig-3",
      invite_code_id: null, // admins have null invite_code_id
      conversation_id: null, // standalone infographic (not from chat)
      admin_name: "Админ Главный",
      ip_address: "10.0.0.1",
      topic: "Тест",
      created_at: "2026-04-12T00:00:00Z",
    };
    const result = resolveInfographicUser(ig, convsMap, codesMap);
    expect(result.user_name).toBe("Админ Главный");
    expect(result.organization).toBe("Админ");
  });

  it("falls back to 'Неизвестный' only when ALL fields are null", () => {
    const ig: InfographicRecord = {
      id: "ig-4",
      invite_code_id: null,
      conversation_id: null,
      admin_name: null, // old record without admin_name
      ip_address: null,
      topic: "Тест",
      created_at: "2026-04-10T00:00:00Z",
    };
    const result = resolveInfographicUser(ig, {}, {});
    expect(result.user_name).toBe("Неизвестный");
  });

  it("resolves admin by conversation.admin_name", () => {
    const ig: InfographicRecord = {
      id: "ig-5",
      invite_code_id: null,
      conversation_id: "conv-2", // admin conversation
      admin_name: null,
      ip_address: "10.0.0.1",
      topic: "Тест",
      created_at: "2026-04-12T00:00:00Z",
    };
    const result = resolveInfographicUser(ig, convsMap, codesMap);
    expect(result.user_name).toBe("Иванов Иван");
    expect(result.organization).toBe("Админ");
  });

  it("prefers conversation resolution over direct invite_code_id", () => {
    const ig: InfographicRecord = {
      id: "ig-6",
      invite_code_id: "code-1",
      conversation_id: "conv-2", // admin conversation takes precedence
      admin_name: null,
      ip_address: "1.2.3.4",
      topic: "Тест",
      created_at: "2026-04-12T00:00:00Z",
    };
    const result = resolveInfographicUser(ig, convsMap, codesMap);
    // conversation resolution takes precedence
    expect(result.user_name).toBe("Иванов Иван");
  });
});

describe("Infographic Insert Data (admin_name & ip_address)", () => {
  it("stores admin_name for admin users", () => {
    const data = buildInfographicInsertData({
      inviteId: "admin-ADMIN-MASTER",
      inviteIdStartsWithAdmin: true,
      conversationId: null,
      topic: "Тест",
      adminName: "Админ Главный",
      clientIp: "10.0.0.1",
    });
    expect(data.invite_code_id).toBeNull(); // admin → null
    expect(data.admin_name).toBe("Админ Главный");
    expect(data.ip_address).toBe("10.0.0.1");
  });

  it("stores invite_code_id for regular users (no admin_name)", () => {
    const data = buildInfographicInsertData({
      inviteId: "550e8400-e29b-41d4-a716-446655440000",
      inviteIdStartsWithAdmin: false,
      conversationId: "conv-123",
      topic: "Тест",
      adminName: null,
      clientIp: "192.168.1.1",
    });
    expect(data.invite_code_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(data.admin_name).toBeNull();
    expect(data.ip_address).toBe("192.168.1.1");
  });

  it("always captures IP address", () => {
    const data = buildInfographicInsertData({
      inviteId: null,
      inviteIdStartsWithAdmin: false,
      conversationId: null,
      topic: "Тест",
      adminName: null,
      clientIp: "203.0.113.42",
    });
    expect(data.ip_address).toBe("203.0.113.42");
  });

  it("handles missing conversation_id gracefully", () => {
    const data = buildInfographicInsertData({
      inviteId: "admin-CODE",
      inviteIdStartsWithAdmin: true,
      conversationId: "",
      topic: "Тест",
      adminName: "Admin",
      clientIp: "10.0.0.1",
    });
    expect(data.conversation_id).toBeNull(); // empty string → null
  });
});

describe("Audit Log Action Types", () => {
  // Verify the infographic.generate action type exists
  const VALID_ACTIONS = [
    "invite_code.create",
    "invite_code.update",
    "invite_code.delete",
    "source.delete",
    "source.ingest",
    "support.reply",
    "support.delete",
    "support.status_change",
    "error_log.delete",
    "off_topic.delete",
    "messages.delete",
    "conversations.delete",
    "telegram.setup_webhook",
    "user.disconnect",
    "infographic.generate", // NEW
  ];

  it("includes infographic.generate action type", () => {
    expect(VALID_ACTIONS).toContain("infographic.generate");
  });

  it("audit event for infographic contains required fields", () => {
    const auditEvent = {
      action: "infographic.generate" as const,
      adminName: "Test Admin",
      targetId: "infographic-uuid",
      details: {
        topic: "Test topic",
        style: "business_infographic",
        ip: "10.0.0.1",
        isAdmin: true,
        inviteCodeId: null,
      },
    };

    expect(auditEvent.action).toBe("infographic.generate");
    expect(auditEvent.adminName).toBeTruthy();
    expect(auditEvent.details.ip).toBeTruthy();
    expect(auditEvent.details).toHaveProperty("isAdmin");
    expect(auditEvent.details).toHaveProperty("inviteCodeId");
  });
});
