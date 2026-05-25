"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import type { ApexOptions } from "apexcharts";

// react-apexcharts обращается к window при импорте — грузим только на клиенте.
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

export interface LegendItem {
  label: string;
  color: string;
  value?: string | number;
}

interface ChartCardProps {
  title: string;
  type: "line" | "area" | "bar" | "donut" | "pie";
  series: ApexAxisChartSeries | ApexNonAxisChartSeries;
  options: ApexOptions;
  height?: number;
  legend?: LegendItem[];
}

export default function ChartCard({ title, type, series, options, height = 320, legend }: ChartCardProps) {
  // ApexCharts при dynamic-импорте часто измеряет контейнер до раскладки grid
  // и схлопывает график (donut → точка). Несколько ресайз-нуджей после
  // монтирования заставляют пересчитать размеры.
  useEffect(() => {
    const timers = [80, 250, 600].map((d) =>
      setTimeout(() => window.dispatchEvent(new Event("resize")), d)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-header-left">
          <h3 className="admin-card-title">{title}</h3>
        </div>
      </div>
      <div style={{ padding: "8px 16px 16px", width: "100%" }}>
        <ReactApexChart type={type} series={series} options={options} height={height} width="100%" />
        {legend && legend.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", justifyContent: "center", marginTop: 8 }}>
            {legend.map((it) => (
              <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569" }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: it.color, flexShrink: 0 }} />
                {it.label}{it.value !== undefined ? `: ${it.value}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
