import { getMoscowTime } from "./date-utils";

export interface SecurityEventRow {
  event_type: string;
  ip_address: string | null;
}

export interface SpikeBreach {
  eventType: string;
  count: number;
  threshold: number;
}

// Per-window thresholds. Crossing the value triggers a Telegram alert.
// Tuned to match the 15-minute cron cadence in security-alerts-cron.yml.
export const DEFAULT_SPIKE_THRESHOLDS: Record<string, number> = {
  "auth.password_fail": 30,
  "auth.otp_fail": 30,
  "auth.invite_code_fail": 50,
  "auth.device_limit": 10,
  "auth.admin_2fa_fail": 5,
  "auth.admin_2fa_setup_rejected": 3,
  "auth.admin_2fa_verify_rejected": 5,
  "auth.admin_2fa_setup": 5,
  "rate_limit.hit": 200,
  "admin.ip_blocked": 1,
};

export function evaluateSpikes(
  events: SecurityEventRow[],
  thresholds: Record<string, number> = DEFAULT_SPIKE_THRESHOLDS
): {
  counts: Record<string, number>;
  topIps: Record<string, Array<{ ip: string; count: number }>>;
  breaches: SpikeBreach[];
} {
  const counts: Record<string, number> = {};
  const ipsByType: Record<string, Map<string, number>> = {};
  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    if (e.ip_address) {
      const m = (ipsByType[e.event_type] ??= new Map());
      m.set(e.ip_address, (m.get(e.ip_address) ?? 0) + 1);
    }
  }
  const topIps: Record<string, Array<{ ip: string; count: number }>> = {};
  for (const [type, m] of Object.entries(ipsByType)) {
    topIps[type] = [...m.entries()]
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  }
  const breaches = Object.entries(counts)
    .filter(([type, count]) => count >= (thresholds[type] ?? Infinity))
    .map(([eventType, count]) => ({
      eventType,
      count,
      threshold: thresholds[eventType] ?? 0,
    }))
    .sort((a, b) => b.count / b.threshold - a.count / a.threshold);
  return { counts, topIps, breaches };
}

export function formatSpikeAlert(
  windowMinutes: number,
  breaches: SpikeBreach[],
  topIps: Record<string, Array<{ ip: string; count: number }>>
): string {
  const lines: string[] = [
    `🚨 <b>Security spike</b> (последние ${windowMinutes} мин)`,
    "",
  ];
  for (const b of breaches) {
    lines.push(
      `• <code>${b.eventType}</code>: <b>${b.count}</b> (порог ${b.threshold})`
    );
    const ips = topIps[b.eventType] ?? [];
    if (ips.length > 0) {
      const tail = ips.map((x) => `${x.ip}×${x.count}`).join(", ");
      lines.push(`   IP: ${tail}`);
    }
  }
  lines.push("", `🕐 ${getMoscowTime()}`);
  return lines.join("\n");
}
