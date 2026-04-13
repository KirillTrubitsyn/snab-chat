/**
 * In-memory admin presence tracker.
 * Admins don't have entries in the devices table, so we track their
 * last_seen_at separately to include them in the online-users list.
 */

interface AdminPresenceEntry {
  code: string;
  name: string;
  lastSeenAt: string;
}

const presence = new Map<string, AdminPresenceEntry>();

export function updateAdminPresence(code: string, name: string): void {
  presence.set(code.toUpperCase(), {
    code: code.toUpperCase(),
    name,
    lastSeenAt: new Date().toISOString(),
  });
}

export function getOnlineAdmins(cutoffISO: string): AdminPresenceEntry[] {
  const result: AdminPresenceEntry[] = [];
  for (const [key, entry] of presence) {
    if (entry.lastSeenAt >= cutoffISO) {
      result.push(entry);
    } else {
      // Clean up stale entries
      presence.delete(key);
    }
  }
  return result;
}
