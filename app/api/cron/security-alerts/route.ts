import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { notifyAllAdmins } from "@/app/lib/telegram";

const EVENT_LABELS: Record<string, string> = {
  "auth.password_fail": "Неверный пароль",
  "auth.otp_fail": "Неверный OTP-код",
  "auth.invite_code_fail": "Неверный инвайт-код",
  "auth.device_limit": "Превышен лимит устройств",
  "rate_limit.hit": "Rate limit",
  "admin.ip_blocked": "Блокировка admin IP",
};

/**
 * GET /api/cron/security-alerts
 *
 * Checks for security event spikes in the last 15 minutes.
 * Call from Railway Cron or external scheduler every 15 min.
 * Requires CRON_SECRET header for authentication.
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createServiceClient();

    const { data: alerts, error } = await supabase.rpc("check_security_alerts", {
      window_minutes: 15,
    });

    if (error) {
      console.error("[security-alerts] RPC error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!alerts || alerts.length === 0) {
      return NextResponse.json({ status: "ok", alerts: 0 });
    }

    // Build Telegram alert message
    const lines = alerts.map(
      (a: { event_type: string; event_count: number }) =>
        `• <b>${EVENT_LABELS[a.event_type] || a.event_type}</b>: ${a.event_count} раз`
    );

    const text =
      `🚨 <b>Security Alert</b>\n\n` +
      `За последние 15 минут:\n${lines.join("\n")}\n\n` +
      `Проверьте таблицу <code>security_events</code> в Supabase.`;

    await notifyAllAdmins(text);

    return NextResponse.json({ status: "alerted", alerts: alerts.length });
  } catch (err) {
    console.error("[security-alerts] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
