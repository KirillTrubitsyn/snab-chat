"use client";

import { useState, useCallback, useEffect } from "react";
import type { ApexOptions } from "apexcharts";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";
import ChartCard from "./ChartCard";

type Period = "today" | "7days" | "30days" | "all";

const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7days", label: "7 дней" },
  { key: "30days", label: "30 дней" },
  { key: "all", label: "Все время" },
];

interface AnalyticsData {
  kpis: {
    totalRequests: number;
    uniqueUsers: number;
    orgCount: number;
    chat: number;
    infographic: number;
    document: number;
  };
  activityOverTime: { categories: string[]; series: { name: string; data: number[] }[] };
  typeBreakdown: { labels: string[]; series: number[] };
  topUsers: { userName: string; organization: string | null; count: number }[];
  byOrg: { labels: string[]; series: number[] };
  platformSplit: { labels: string[]; series: number[] };
}

const PALETTE = ["#1976D2", "#42A5F5", "#7DD3FC", "#0D47A1", "#90CAF9", "#1565C0", "#64B5F6"];

// Цвет на категорию (чтобы один и тот же тип был одного цвета во всех графиках).
const TYPE_COLORS: Record<string, string> = {
  "Чат": "#1976D2",
  "Документы": "#42A5F5",
  "Инфографика": "#7DD3FC",
};
const PLATFORM_COLORS: Record<string, string> = {
  "Десктоп": "#1976D2",
  "Мобильный": "#42A5F5",
};
const colorFor = (map: Record<string, string>, label: string, i: number) => map[label] || PALETTE[i % PALETTE.length];

export default function AnalyticsTab({ adminCode }: { adminCode: string }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("30days");
  const [org, setOrg] = useState("");

  const headers = getAdminHeaders(adminCode);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ period });
      if (org) params.set("org", org);
      const res = await fetch(apiUrl(`/api/admin/analytics?${params.toString()}`), { headers });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Не удалось загрузить аналитику");
        setData(null);
      } else {
        setData(json);
      }
    } catch {
      setError("Не удалось загрузить аналитику");
      setData(null);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminCode, period, org]);

  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  const kpiCards = data
    ? [
        { label: "Всего запросов", value: data.kpis.totalRequests },
        { label: "Активных пользователей", value: data.kpis.uniqueUsers },
        { label: "Организаций", value: data.kpis.orgCount },
        { label: "Чат", value: data.kpis.chat },
        { label: "Инфографика", value: data.kpis.infographic },
        { label: "Документы", value: data.kpis.document },
      ]
    : [];

  const baseChart = (extra: ApexOptions): ApexOptions => ({
    chart: { toolbar: { show: false }, fontFamily: "inherit" },
    colors: PALETTE,
    // Встроенная HTML-легенда ApexCharts ломается глобальным ресетом `* {margin:0}`
    // (маркеры разъезжаются, подписи пропадают) — рисуем свою легенду в ChartCard.
    legend: { show: false },
    // Tooltip ApexCharts мисспозиционируется (залипает в углу) из-за того же
    // ресета — отключаем; данные видны на подписях, легенде и осях.
    tooltip: { enabled: false },
    dataLabels: { enabled: false },
    ...extra,
  });

  const areaColors = (data?.activityOverTime.series || []).map((s, i) => colorFor(TYPE_COLORS, s.name, i));
  const areaOptions: ApexOptions = baseChart({
    chart: { type: "area", stacked: true, toolbar: { show: false }, fontFamily: "inherit" },
    xaxis: { categories: data?.activityOverTime.categories || [], type: "datetime" },
    stroke: { curve: "smooth", width: 2 },
    fill: { type: "gradient", gradient: { opacityFrom: 0.5, opacityTo: 0.1 } },
    colors: areaColors,
  });

  const donut = (labels: string[], colors: string[]): ApexOptions =>
    baseChart({ labels, colors, dataLabels: { enabled: true } });

  const typeColors = (data?.typeBreakdown.labels || []).map((l, i) => colorFor(TYPE_COLORS, l, i));
  const platformColors = (data?.platformSplit.labels || []).map((l, i) => colorFor(PLATFORM_COLORS, l, i));

  const horizontalBar = (categories: string[], color: string): ApexOptions =>
    baseChart({
      chart: { type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
      plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: "70%" } },
      xaxis: { categories },
      yaxis: { labels: { maxWidth: 280, style: { fontSize: "12px" } } },
      legend: { show: false },
      colors: [color],
    });

  const topUsersCats = data?.topUsers.map((u) => u.userName) || [];
  const barOptions = horizontalBar(topUsersCats, "#1976D2");
  const orgBarOptions = horizontalBar(data?.byOrg.labels || [], "#42A5F5");

  const hasData = data && data.kpis.totalRequests > 0;

  return (
    <div>
      {/* Filters */}
      <div className="admin-card" style={{ marginBottom: 16 }}>
        <div style={{ padding: "12px 24px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div className="admin-doc-pills">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                className={`admin-doc-pill ${period === p.key ? "active" : ""}`}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {data && data.byOrg.labels.length > 0 && (
            <select
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              style={{ height: 36, fontSize: 13, padding: "0 8px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#fff", color: "#0F172A", cursor: "pointer" }}
            >
              <option value="">Все организации</option>
              {data.byOrg.labels.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          <button className="admin-btn-secondary" onClick={loadAnalytics} disabled={loading}>
            <span className="material-symbols-outlined">refresh</span>
            Обновить
          </button>
        </div>
      </div>

      {loading ? (
        <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
      ) : error ? (
        <div className="admin-empty">{error}</div>
      ) : !hasData ? (
        <div className="admin-empty">Нет данных за выбранный период</div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="admin-kpi-grid">
            {kpiCards.map((c) => (
              <div key={c.label} className="admin-kpi-card">
                <div className="admin-kpi-value">{c.value.toLocaleString("ru-RU")}</div>
                <div className="admin-kpi-label">{c.label}</div>
              </div>
            ))}
          </div>

          {/* Charts */}
          <div className="admin-chart-grid">
            <div style={{ gridColumn: "1 / -1" }}>
              <ChartCard
                title="Активность во времени"
                type="area"
                series={data!.activityOverTime.series}
                options={areaOptions}
                height={340}
                legend={data!.activityOverTime.series.map((s, i) => ({ label: s.name, color: areaColors[i] }))}
              />
            </div>
            <ChartCard
              title="Типы запросов"
              type="donut"
              series={data!.typeBreakdown.series}
              options={donut(data!.typeBreakdown.labels, typeColors)}
              legend={data!.typeBreakdown.labels.map((l, i) => ({ label: l, color: typeColors[i], value: data!.typeBreakdown.series[i] }))}
            />
            <ChartCard
              title="Мобильный / десктоп"
              type="donut"
              series={data!.platformSplit.series}
              options={donut(data!.platformSplit.labels, platformColors)}
              legend={data!.platformSplit.labels.map((l, i) => ({ label: l, color: platformColors[i], value: data!.platformSplit.series[i] }))}
            />
            <ChartCard
              title="Топ активных пользователей"
              type="bar"
              series={[{ name: "Запросы", data: data!.topUsers.map((u) => u.count) }]}
              options={barOptions}
              height={Math.max(320, data!.topUsers.length * 42)}
            />
            <div style={{ gridColumn: "1 / -1" }}>
              <ChartCard
                title="По организациям"
                type="bar"
                series={[{ name: "Запросы", data: data!.byOrg.series }]}
                options={orgBarOptions}
                height={Math.max(320, data!.byOrg.labels.length * 38)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
