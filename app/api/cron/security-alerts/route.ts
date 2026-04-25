import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/app/lib/supabase";
import { notifyAllAdmins } from "@/app/lib/telegram";
import {
  DEFAULT_SPIKE_THRESHOLDS,
  evaluateSpikes,
  formatSpikeAlert,
  type SecurityEventRow,
} from "@/app/lib/security-alerts";

// Force Node.js runtime — uses node:crypto and Supabase service client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MINUTES = 15;

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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

    const { counts, topIps, breaches } = evaluateSpikes(events, DEFAULT_SPIKE_THRESHOLDS);

    if (breaches.length > 0) {
      const text = formatSpikeAlert(WINDOW_MINUTES, breaches, topIps);
      // notifyAllAdmins already swallows network errors; await so the cron run
      // reflects delivery latency.
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
