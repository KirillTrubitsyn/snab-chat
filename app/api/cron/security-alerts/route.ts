import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/app/lib/supabase";
import { notifyAllAdmins } from "@/app/lib/telegram";
import { getMoscowTime } from "@/app/lib/date-utils";

// Force Node.js runtime — uses node:crypto and Supabase service client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MINUTES = 15;

// Per-window thresholds. Crossing the value triggers a Telegram alert.
// Tuned to match the 15-minute cron cadence in security-alerts-cron.yml.
const THRESHOLDS: Record<string, number> = {
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

interface SecurityEventRow {
  event_type: string;
  ip_address: string | null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function evaluateSpikes(
  events: SecurityEventRow[],
  thresholds: Record<string, number> = THRESHOLDS
): {
  counts: Record<string, number>;
  topIps: Record<string, Array<{ ip: string; count: number }>>;
  breaches: Array<{ eventType: string; count: number; threshold: number }>;
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

function formatAlert(
  windowMinutes: number,
  breaches: Array<{ eventType: string; count: number; threshold: number }>,
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

export async function GET(request: NextRequest) {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected) {
    console.error("[cron/security-alerts] CRON_SECRET is not set");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 401 });
  }

  try {
    const supabase = createServiceClient();
    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("security_events")
      .select("event_type, ip_address")
      .gte("created_at", since)
      .limit(10_000);
    if (error) throw error;
    const events = (data ?? []) as SecurityEventRow[];

    const { counts, topIps, breaches } = evaluateSpikes(events);

    if (breaches.length > 0) {
      const text = formatAlert(WINDOW_MINUTES, breaches, topIps);
      // Fire-and-forget: notifyAllAdmins already swallows network errors,
      // but await here so the cron run reflects delivery latency.
      await notifyAllAdmins(text);
    }

    return NextResponse.json({
      ok: true,
      windowMinutes: WINDOW_MINUTES,
      total: events.length,
      counts,
      breaches,
    });
  } catch (e) {
    console.error("[cron/security-alerts] failed:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
