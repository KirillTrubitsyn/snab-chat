"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import type { ApexOptions } from "apexcharts";

// react-apexcharts обращается к window при импорте — грузим только на клиенте.
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

interface ChartCardProps {
  title: string;
  type: "line" | "area" | "bar" | "donut" | "pie";
  series: ApexAxisChartSeries | ApexNonAxisChartSeries;
  options: ApexOptions;
  height?: number;
}

export default function ChartCard({ title, type, series, options, height = 320 }: ChartCardProps) {
  // ApexCharts при dynamic-импорте часто измеряет контейнер до раскладки grid
  // и схлопывает график (donut → точка, легенда растягивается). Несколько
  // ресайз-нуджей после монтирования заставляют пересчитать размеры.
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
      </div>
    </div>
  );
}
