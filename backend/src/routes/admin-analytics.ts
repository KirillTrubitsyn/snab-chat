import { Router, Request, Response } from "express";
import { requireAdmin } from "../lib/auth.js";
import { createServiceClient } from "../lib/supabase.js";

const router = Router();

type Period = "today" | "7days" | "30days" | "all";
const TYPE_LABELS: Record<string, string> = {
  chat: "Чат",
  infographic: "Инфографика",
  document: "Документы",
};
const TYPE_ORDER = ["chat", "infographic", "document"];

function resolveRange(period: Period, from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const end = to ? new Date(to) : now;
  if (from) return { from: new Date(from).toISOString(), to: end.toISOString() };

  const start = new Date(now);
  if (period === "today") start.setHours(0, 0, 0, 0);
  else if (period === "7days") start.setDate(now.getDate() - 7);
  else if (period === "30days") start.setDate(now.getDate() - 30);
  else start.setTime(0); // all time → epoch
  return { from: start.toISOString(), to: end.toISOString() };
}

/* ══════════════════════════════════════════════════════════════
   GET /api/admin/analytics — агрегированная статистика за период
   ══════════════════════════════════════════════════════════════ */
router.get("/api/admin/analytics", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const period = ((req.query.period as string) || "30days") as Period;
    const org = (req.query.org as string)?.trim() || null;
    const bucket = ["day", "week", "month"].includes(req.query.bucket as string)
      ? (req.query.bucket as string)
      : "day";
    const { from, to } = resolveRange(
      period,
      req.query.from as string | undefined,
      req.query.to as string | undefined
    );

    const supabase = createServiceClient();
    const p = { p_from: from, p_to: to, p_org: org };

    const [kpiRes, overTimeRes, typeRes, usersRes, orgRes, platformRes] = await Promise.all([
      supabase.rpc("analytics_kpis", p),
      supabase.rpc("analytics_activity_over_time", { ...p, p_bucket: bucket }),
      supabase.rpc("analytics_type_breakdown", p),
      supabase.rpc("analytics_top_users", { ...p, p_limit: 10 }),
      supabase.rpc("analytics_by_org", { p_from: from, p_to: to }),
      supabase.rpc("analytics_platform_split", p),
    ]);

    const firstError = [kpiRes, overTimeRes, typeRes, usersRes, orgRes, platformRes].find((r) => r.error)?.error;
    if (firstError) {
      console.error("[admin/analytics] RPC error:", firstError.message);
      // 42883 = undefined_function, PGRST202 = PostgREST не нашёл функцию
      if (firstError.code === "42883" || firstError.code === "PGRST202") {
        return res.status(503).json({
          error: "Аналитика недоступна: примените миграцию supabase/migration_analytics_rpc.sql",
        });
      }
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }

    const n = (v: unknown) => Number(v ?? 0);

    // KPI
    const k = (kpiRes.data || [])[0] || {};
    const kpis = {
      totalRequests: n(k.total_requests),
      uniqueUsers: n(k.unique_users),
      orgCount: n(k.org_count),
      chat: n(k.chat_cnt),
      infographic: n(k.infographic_cnt),
      document: n(k.document_cnt),
    };

    // Активность во времени → categories + серия на каждый тип (zero-fill)
    const otRows = (overTimeRes.data || []) as { bucket: string; req_type: string; cnt: number }[];
    const categories = [...new Set(otRows.map((r) => r.bucket))].sort();
    const activityOverTime = {
      categories,
      series: TYPE_ORDER.map((t) => ({
        name: TYPE_LABELS[t],
        data: categories.map((b) => n(otRows.find((r) => r.bucket === b && r.req_type === t)?.cnt)),
      })),
    };

    // Разбивка по типам
    const tbRows = (typeRes.data || []) as { req_type: string; cnt: number }[];
    const typeBreakdown = {
      labels: tbRows.map((r) => TYPE_LABELS[r.req_type] || r.req_type),
      series: tbRows.map((r) => n(r.cnt)),
    };

    // Топ пользователей
    const topUsers = ((usersRes.data || []) as { user_name: string; organization: string | null; cnt: number }[]).map(
      (r) => ({ userName: r.user_name, organization: r.organization, count: n(r.cnt) })
    );

    // По организациям
    const orgRows = (orgRes.data || []) as { organization: string; cnt: number }[];
    const byOrg = {
      labels: orgRows.map((r) => r.organization),
      series: orgRows.map((r) => n(r.cnt)),
    };

    // Платформа (NULL/false → Десктоп, true → Мобильный)
    let desktop = 0;
    let mobile = 0;
    for (const r of (platformRes.data || []) as { is_mobile: boolean | null; cnt: number }[]) {
      if (r.is_mobile === true) mobile += n(r.cnt);
      else desktop += n(r.cnt);
    }
    const platformSplit = { labels: ["Десктоп", "Мобильный"], series: [desktop, mobile] };

    return res.json({
      period: { from, to, bucket },
      kpis,
      activityOverTime,
      typeBreakdown,
      topUsers,
      byOrg,
      platformSplit,
    });
  } catch (err) {
    console.error("GET /api/admin/analytics error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export default router;
